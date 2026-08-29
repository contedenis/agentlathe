import { createServer } from "node:http";

const port = Number(process.argv[2]);

createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/number") {
    res.end(JSON.stringify({ number: 7 }));
    return;
  }
  if (req.url === "/cleanup") {
    res.end(JSON.stringify({ cleaned: true }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "unknown tool endpoint" }));
}).listen(port, "127.0.0.1", () => {
  console.log(`tool server ready on ${port}`);
});
