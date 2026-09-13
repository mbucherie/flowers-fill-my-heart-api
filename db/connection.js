const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  ...(process.env.DB_SOCKET
    ? { socketPath: process.env.DB_SOCKET }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306)
      }),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
