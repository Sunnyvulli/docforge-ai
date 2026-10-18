/* Incremental SSE parsing shared by the browser and node:test. */
(function (root) {
  'use strict';
  function createSSEParser(onEvent) {
    let buffer = '';
    return {
      push(chunk) {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) onEvent(JSON.parse(data));
        }
      },
      finish() { if (buffer.trim()) throw new Error('Incomplete event stream'); }
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createSSEParser };
  else root.createSSEParser = createSSEParser;
})(typeof globalThis !== 'undefined' ? globalThis : this);
