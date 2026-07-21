const http = require('http');
const app = require('./app');
const dotenv = require('dotenv');

dotenv.config();

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);

server.listen(port, host, () => {
  console.log(`Server running on http://${host}:${port}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
