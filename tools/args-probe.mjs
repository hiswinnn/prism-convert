import { buildArgs } from '../src/core/media.js';
const cases = [
  ['convert', {}, { ext: 'wav' }, 'output.mp3'],
  ['convert', { audioBitrate: '128k' }, { ext: 'wav' }, 'output.flac'],
  ['extractAudio', {}, { ext: 'mp4' }, 'output.mp3'],
  ['trim', { trimStart: '0', trimEnd: '1' }, { ext: 'wav' }, 'output.mp3'],
];
for (const [action, options, input, output] of cases) {
  console.log(action, JSON.stringify(options));
  console.log('   ', buildArgs(action, options, input, output).join(' '));
}
