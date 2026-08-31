'use strict';

const crypto = require('node:crypto');

const SOURCE_PLACEHOLDER = '<source.obj>';
const OUTPUT_PLACEHOLDER = '<output>';
const LEGACY_CONTROLLED_CONVERTER = Object.freeze({
  name: 'OpenDroneMap/Obj2Tiles',
  version: '1.6.2',
  arguments: Object.freeze([
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5',
    '--local', SOURCE_PLACEHOLDER, OUTPUT_PLACEHOLDER,
  ]),
});
const LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256 = '7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681';

const CONTROLLED_CONVERTER = Object.freeze({
  name: 'OpenDroneMap/Obj2Tiles',
  version: '1.6.2',
  arguments: Object.freeze([
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5',
    '--texture-format', 'Ktx2',
    '--ktx2-quality', '192',
    '--local', SOURCE_PLACEHOLDER, OUTPUT_PLACEHOLDER,
  ]),
});

const CONTROLLED_CONVERTER_BINARY_SHA256 = Object.freeze([
  '40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274',
  'c54dbcbe953640f2aa0e7c2568709108a97063dac492781c9560a5042e46d9b1',
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const CONTROLLED_CONVERTER_COMMAND_SHA256 = crypto
  .createHash('sha256')
  .update(stable(CONTROLLED_CONVERTER))
  .digest('hex');
const ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256 = Object.freeze([
  LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  CONTROLLED_CONVERTER_COMMAND_SHA256,
]);
const ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS = Object.freeze([
  Object.freeze({
    converter: LEGACY_CONTROLLED_CONVERTER,
    commandSha256: LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  }),
  Object.freeze({
    converter: CONTROLLED_CONVERTER,
    commandSha256: CONTROLLED_CONVERTER_COMMAND_SHA256,
  }),
]);

function obj2TilesArguments(source, output) {
  return CONTROLLED_CONVERTER.arguments.map((argument) => {
    if (argument === SOURCE_PLACEHOLDER) return source;
    if (argument === OUTPUT_PLACEHOLDER) return output;
    return argument;
  });
}

module.exports = {
  ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256,
  ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS,
  CONTROLLED_CONVERTER,
  CONTROLLED_CONVERTER_BINARY_SHA256,
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  LEGACY_CONTROLLED_CONVERTER,
  LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  obj2TilesArguments,
  stable,
};
