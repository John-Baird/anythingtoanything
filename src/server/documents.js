const fs = require("fs/promises");
const marked = require("marked");
const TurndownService = require("turndown");
const mammoth = require("mammoth");
const htmlToDocx = require("html-to-docx");
const { convert: htmlToText } = require("html-to-text");

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const DOC_INPUT_EXTENSIONS = ["txt", "text", "md", "markdown", "html", "htm", "docx", "pdf"];

const DOC_TARGETS = {
	txt: { ext: "txt", mime: "text/plain" },
	md: { ext: "md", mime: "text/markdown" },
	html: { ext: "html", mime: "text/html" },
	docx: {
		ext: "docx",
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	},
	pdf: { ext: "pdf", mime: "application/pdf" },
};

const DOC_ORDER = Object.keys(DOC_TARGETS);

const PDF_RENDER_TIMEOUT_MS = 30_000;

class DocumentError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

function normalizeDoc(ext) {
	if (ext === "markdown") return "md";
	if (ext === "htm") return "html";
	if (ext === "text") return "txt";
	return ext;
}

// ---------------------------------------------------------------------------
// HTML helpers (HTML is the pivot format)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textToHtml(text) {
	const paragraphs = escapeHtml(text)
		.split(/\r?\n\r?\n+/)
		.map((p) => `<p>${p.replace(/\r?\n/g, "<br>")}</p>`)
		.join("\n");
	return paragraphs || "<p></p>";
}

function looksLikeFullDocument(html) {
	return /<html[\s>]/i.test(html);
}

function wrapHtml(body, title = "Document") {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
h1, h2, h3, h4 { line-height: 1.25; }
img { max-width: 100%; }
pre { background: #f5f5f5; padding: 1rem; overflow: auto; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; }
table { border-collapse: collapse; }
td, th { border: 1px solid #ccc; padding: 0.4rem 0.6rem; }
blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 1rem; color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Input -> HTML
// ---------------------------------------------------------------------------

async function readToHtml(inputPath, inputExt) {
	const ext = normalizeDoc(inputExt);

	if (ext === "txt") {
		return textToHtml(await fs.readFile(inputPath, "utf8"));
	}
	if (ext === "md") {
		return marked.parse(await fs.readFile(inputPath, "utf8"));
	}
	if (ext === "html") {
		return fs.readFile(inputPath, "utf8");
	}
	if (ext === "docx") {
		try {
			const { value } = await mammoth.convertToHtml({ path: inputPath });
			return value;
		} catch {
			throw new DocumentError("Could not read the DOCX file", 422);
		}
	}
	throw new DocumentError(`Unsupported document type: ${inputExt}`, 400);
}

// ---------------------------------------------------------------------------
// HTML -> output
// ---------------------------------------------------------------------------

async function htmlToPdf(fullHtml, outputPath) {
	let puppeteer;
	try {
		puppeteer = require("puppeteer");
	} catch {
		throw new DocumentError("PDF export is not available on this server", 501);
	}

	let browser;
	try {
		browser = await puppeteer.launch({
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
		});
		const page = await browser.newPage();

		// Block every external request: no SSRF via user HTML, and faster renders.
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			const url = req.url();
			if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) {
				req.continue();
			} else {
				req.abort();
			}
		});

		await page.setContent(fullHtml, { waitUntil: "load", timeout: PDF_RENDER_TIMEOUT_MS });
		await page.pdf({
			path: outputPath,
			format: "A4",
			printBackground: true,
			margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
		});
	} catch (err) {
		if (err instanceof DocumentError) throw err;
		throw new DocumentError("PDF rendering failed", 500);
	} finally {
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

async function writeDocxFromHtml(fullHtml, outputPath) {
	const result = await htmlToDocx(fullHtml, null, { footer: false, pageNumber: false });
	let buffer;
	if (Buffer.isBuffer(result)) {
		buffer = result;
	} else if (result && typeof result.arrayBuffer === "function") {
		buffer = Buffer.from(await result.arrayBuffer());
	} else {
		buffer = Buffer.from(result);
	}
	await fs.writeFile(outputPath, buffer);
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

async function convertDocument({ inputPath, inputExt, target, outputPath, onProgress = () => {} }) {
	if (!DOC_TARGETS[target]) {
		throw new DocumentError(`Unsupported target format: ${target || "(none)"}`);
	}

	onProgress(0.1);

	// PDF is read-only: text extraction only.
	if (normalizeDoc(inputExt) === "pdf") {
		if (target !== "txt") {
			throw new DocumentError("PDF can only be converted to text", 400);
		}
		const { PDFParse } = require("pdf-parse");
		const parser = new PDFParse({ data: await fs.readFile(inputPath) });
		try {
			const { text } = await parser.getText();
			await fs.writeFile(outputPath, text || "");
		} catch {
			throw new DocumentError("Could not read the PDF", 422);
		} finally {
			await parser.destroy?.().catch?.(() => {});
		}
		onProgress(1);
		return;
	}

	const rawHtml = await readToHtml(inputPath, inputExt);
	onProgress(0.5);

	const fullHtml = looksLikeFullDocument(rawHtml) ? rawHtml : wrapHtml(rawHtml);

	switch (target) {
		case "html":
			await fs.writeFile(outputPath, fullHtml);
			break;
		case "txt":
			await fs.writeFile(outputPath, htmlToText(fullHtml, { wordwrap: 100 }));
			break;
		case "md":
			await fs.writeFile(
				outputPath,
				new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(rawHtml),
			);
			break;
		case "docx":
			await writeDocxFromHtml(fullHtml, outputPath);
			break;
		case "pdf":
			await htmlToPdf(fullHtml, outputPath);
			break;
		default:
			throw new DocumentError(`Unsupported target format: ${target}`);
	}

	onProgress(1);
}

module.exports = {
	DOC_INPUT_EXTENSIONS,
	DOC_TARGETS,
	DOC_ORDER,
	DocumentError,
	normalizeDoc,
	convertDocument,
};
