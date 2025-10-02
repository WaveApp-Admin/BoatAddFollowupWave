const crypto = require('crypto');

module.exports = function requestTrace() {
  return (req, res, next) => {
    const rid = req.headers['x-request-id'] || crypto.randomUUID();
    req.rid = rid;
    const start = Date.now();
    console.log(`[REQ ${rid}] ${req.method} ${req.originalUrl}`);
    if (req.headers) console.log(`[REQ ${rid}] headers=${JSON.stringify(req.headers)}`);
    if (req.body)    console.log(`[REQ ${rid}] body=${JSON.stringify(req.body)}`);
    setImmediate(() => {
      if (req.body) console.log(`[REQ ${rid}] body=${JSON.stringify(req.body)}`);
    });
    res.on('finish', () => {
      console.log(`[RES ${rid}] status=${res.statusCode} durationMs=${Date.now() - start}`);
    });
    next();
  };
};
