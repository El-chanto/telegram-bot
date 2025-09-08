// keep_alive.js
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

function keepAlive() {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Keep-alive server is running on port ${port}`);
  });
}

module.exports = keepAlive;
