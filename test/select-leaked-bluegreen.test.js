'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { selectLeakedBlueGreenContainers } = require('../src/container-manager');

const MIN_AGE_MS = 10 * 60 * 1000;
const NOW = 1_000_000_000_000;

test('reaps an aged -old half whose base is not mid-swap', () => {
  // Regression for code-server-proxy-09w: a -old half left running for
  // days because step 6 of blueGreenRecreate failed and no sweep reaped
  // it. Its base instance is not in recreatingInstances, so it must be
  // selected for removal.
  const transients = [
    { instanceId: 'c9ab06-old', createdMs: NOW - 6 * 24 * 60 * 60 * 1000 },
  ];
  const leaked = selectLeakedBlueGreenContainers(
    transients,
    new Set(),
    NOW,
    MIN_AGE_MS
  );
  assert.deepStrictEqual(leaked, ['c9ab06-old']);
});

test('protects a transient whose base is mid-swap', () => {
  const transients = [
    { instanceId: 'abc-old', createdMs: NOW - 60 * 60 * 1000 },
    { instanceId: 'abc-new', createdMs: NOW - 60 * 60 * 1000 },
  ];
  const leaked = selectLeakedBlueGreenContainers(
    transients,
    new Set(['abc']),
    NOW,
    MIN_AGE_MS
  );
  assert.deepStrictEqual(leaked, []);
});

test('protects a freshly created -new (in-flight swap, base not yet registered)', () => {
  const transients = [{ instanceId: 'def-new', createdMs: NOW - 30 * 1000 }];
  const leaked = selectLeakedBlueGreenContainers(
    transients,
    new Set(),
    NOW,
    MIN_AGE_MS
  );
  assert.deepStrictEqual(leaked, []);
});

test('reaps aged transients but spares fresh and mid-swap ones', () => {
  const transients = [
    { instanceId: 'old1-old', createdMs: NOW - 2 * MIN_AGE_MS }, // reap
    { instanceId: 'fresh-new', createdMs: NOW - 1000 }, // too young
    { instanceId: 'busy-old', createdMs: NOW - 2 * MIN_AGE_MS }, // mid-swap
  ];
  const leaked = selectLeakedBlueGreenContainers(
    transients,
    new Set(['busy']),
    NOW,
    MIN_AGE_MS
  );
  assert.deepStrictEqual(leaked, ['old1-old']);
});
