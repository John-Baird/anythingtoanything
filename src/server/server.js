const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, "..") //Targeting the /src



app.get("/api/test", (req, res) => {
	res.json({
		message: "Backend works",
	});
});



app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
