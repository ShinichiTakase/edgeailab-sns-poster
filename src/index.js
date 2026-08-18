const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const threadsRoutes = require("./routes/threads");
const xRoutes = require("./routes/x");
const facebookRoutes = require("./routes/facebook");
const instagramRoutes = require("./routes/instagram");
const authRoutes = require("./routes/auth");
const billingRoutes = require("./routes/billing");
const teamRoutes = require("./routes/team");
const snsConnectionsRoutes = require("./routes/snsConnections");
const accountRoutes = require("./routes/account");
const postsRoutes = require("./routes/posts");
const uploadsRoutes = require("./routes/uploads");
const aiRoutes = require("./routes/ai");
const schedulesRoutes = require("./routes/schedules");

const app = express();
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
app.use(threadsRoutes);
app.use(xRoutes);
app.use(facebookRoutes);
app.use(instagramRoutes);
app.use(authRoutes);
app.use(billingRoutes);
app.use(teamRoutes);
app.use(snsConnectionsRoutes);
app.use(accountRoutes);
app.use(postsRoutes);
app.use(uploadsRoutes);
app.use(aiRoutes);
app.use(schedulesRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.info(`[sns-poster] listening on port ${port}`);
});
