const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Compiled Angular app (produced by `npm run build`).
// __dirname is src/server, so ../../ is the repo root.
const browserDir = path.join(__dirname, "..", "..", "dist", "temp-angular", "browser");

app.use(express.static(browserDir));

app.get("/api/test", (req, res) => {
	res.json({
		message: "Backend works",
	});
});

// SPA fallback: hand any non-API, non-file request to Angular's index.html.
// Express 5 rejects a bare "*" route, so use a final catch-all middleware.
app.use((req, res) => {
	res.sendFile(path.join(browserDir, "index.html"));
});

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});
