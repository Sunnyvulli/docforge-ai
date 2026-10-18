'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSSEParser } = require('../public/sse');
test('every possible network split preserves complete events', () => {
  const message = 'data: {"text":"hello"}\n\ndata: {"done":true,"credits":0}\n\n';
  for (let split = 0; split <= message.length; split++) {
    const events = [];const parser = createSSEParser(x => events.push(x));
    parser.push(message.slice(0, split));parser.push(message.slice(split));parser.finish();
    assert.deepEqual(events, [{ text: 'hello' }, { done: true, credits: 0 }]);
  }
});
test('truncated streams are reported instead of called complete', () => {
  const parser = createSSEParser(() => {});parser.push('data: {"text":');
  assert.throws(() => parser.finish(), /Incomplete/);
});
