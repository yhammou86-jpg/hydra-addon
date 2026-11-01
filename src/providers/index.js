'use strict';

const knaben = require('./knaben');
const yts = require('./yts');
const eztv = require('./eztv');
const bitsearch = require('./bitsearch');
const nyaa = require('./nyaa');
const apibay = require('./apibay');
const animetosho = require('./animetosho');
const therarbg = require('./therarbg');
const torrentgalaxy = require('./torrentgalaxy');
const { PRESETS } = require('./addon');
const stremthru = require('./stremthru');
const prowlarr = require('./prowlarr');
const torznab = require('./torznab');

/**
 * Order matters only for display priority when scores tie.
 *
 * The addon sources come before the raw trackers: they are aggregators, so a
 * single request from one of them returns more usable releases than most of
 * the direct scrapers manage, and their rows arrive pre-labelled.
 */
const ALL = [
  ...PRESETS,
  stremthru,
  knaben,
  yts,
  eztv,
  bitsearch,
  nyaa,
  apibay,
  animetosho,
  therarbg,
  torrentgalaxy,
  prowlarr,
  torznab,
];

const BY_ID = Object.fromEntries(ALL.map((p) => [p.id, p]));

module.exports = { ALL, BY_ID };
