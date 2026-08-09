const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const threadsRoutes = require("./routes/threads");
const xRoutes = require("./routes/x");
const facebookRoutes = require("./routes/facebook");

const app = express();
app.use(threadsRoutes);
app.use(xRoutes);
app.use(facebookRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.info(`[sns-poster] listening on port ${port}`);
});
