const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const publicDir = path.join(__dirname, "..") //Targeting the /src



app.get("/", (req, res) => {
	res.sendFile(path.join(publicDir, "index.html"));
});



app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
