const fs = require("fs/promises");
const XLSX = require("xlsx");

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SPREADSHEET_INPUT_EXTENSIONS = ["csv", "tsv", "xlsx", "xls"];

const SPREADSHEET_TARGETS = {
	csv: { ext: "csv", mime: "text/csv" },
	tsv: { ext: "tsv", mime: "text/tab-separated-values" },
	xlsx: {
		ext: "xlsx",
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		bookType: "xlsx",
	},
	xls: { ext: "xls", mime: "application/vnd.ms-excel", bookType: "xls" },
};

const SPREADSHEET_ORDER = Object.keys(SPREADSHEET_TARGETS);

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_CELLS = 1_000_000;

class SpreadsheetError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countCells(workbook) {
	let total = 0;
	for (const name of workbook.SheetNames) {
		const sheet = workbook.Sheets[name];
		if (!sheet || !sheet["!ref"]) continue;
		const range = XLSX.utils.decode_range(sheet["!ref"]);
		total += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
	}
	return total;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

async function convertSpreadsheet({ inputPath, inputExt, target, outputPath, onProgress = () => {} }) {
	const spec = SPREADSHEET_TARGETS[target];
	if (!spec) {
		throw new SpreadsheetError(`Unsupported target format: ${target || "(none)"}`);
	}

	const stat = await fs.stat(inputPath);
	if (stat.size > MAX_INPUT_BYTES) {
		throw new SpreadsheetError("Spreadsheet is too large (limit 25 MB)", 413);
	}

	onProgress(0.15);

	let workbook;
	try {
		workbook = XLSX.readFile(inputPath, {
			dense: true,
			cellDates: true,
			// .tsv isn't always sniffed correctly; force the separator.
			...(inputExt === "tsv" ? { FS: "\t" } : {}),
		});
	} catch {
		throw new SpreadsheetError("Could not read the spreadsheet", 422);
	}

	if (!workbook.SheetNames.length) {
		throw new SpreadsheetError("The spreadsheet has no sheets", 422);
	}

	if (countCells(workbook) > MAX_CELLS) {
		throw new SpreadsheetError(`Spreadsheet has too many cells (limit ${MAX_CELLS.toLocaleString()})`, 413);
	}

	onProgress(0.6);

	if (target === "csv" || target === "tsv") {
		// CSV/TSV hold a single sheet — use the first one.
		const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
		const text = XLSX.utils.sheet_to_csv(firstSheet, {
			FS: target === "tsv" ? "\t" : ",",
			blankrows: false,
		});
		await fs.writeFile(outputPath, text);
	} else {
		XLSX.writeFile(workbook, outputPath, { bookType: spec.bookType });
	}

	onProgress(1);

	const textTarget = target === "csv" || target === "tsv";
	return {
		multiSheetDropped: textTarget && workbook.SheetNames.length > 1,
		firstSheetName: textTarget ? workbook.SheetNames[0] : null,
	};
}

module.exports = {
	SPREADSHEET_INPUT_EXTENSIONS,
	SPREADSHEET_TARGETS,
	SPREADSHEET_ORDER,
	SpreadsheetError,
	convertSpreadsheet,
};
