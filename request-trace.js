const { createLogger } = require('./server/utils/logger');

/**
 * Generate a request trace ID in format: rtx_{timestamp}_{random}
 */
function generateRid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rtx_${ts}_${rand}`;
}

module.exports = function requestTrace() {
  return (req, res, next) => {
    const rid = req.headers['x-request-id'] || generateRid();
    req.rid = rid;
    req.log = createLogger({ rid });
    
    const start = Date.now();
    req.log.info('request-start', {
      method: req.method,
      url: req.originalUrl,
      stage: 'request',
    });
    
    res.on('finish', () => {
      req.log.info('request-complete', {
        status: res.statusCode,
        durationMs: Date.now() - start,
        stage: 'request',
      });
    });
    
    next();
  };
};
