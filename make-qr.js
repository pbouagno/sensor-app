// Make screenshots/qr.png for a URL:  node make-qr.js https://your-site.example
// (uses the "qrcode" package installed in /tmp/coconut-test)
const QR = require(process.env.QR || "/tmp/coconut-test/node_modules/qrcode");
const url = process.argv[2];
if (!url) { console.error("Usage: node make-qr.js <url>"); process.exit(1); }
QR.toFile(__dirname + "/screenshots/qr.png", url, { width: 600, margin: 2, color: { dark: "#000000", light: "#F0F0FA" } })
  .then(() => console.log("wrote screenshots/qr.png for", url));
