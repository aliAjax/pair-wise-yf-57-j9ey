const esbuild = require('esbuild');
const path = require('path');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'logic-test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(__dirname, '.build/logic-test.cjs'),
    alias: { '@tarojs/taro': path.join(__dirname, 'taro-stub.ts') },
    logLevel: 'silent'
  })
  .then(() => {
    require(path.join(__dirname, '.build/logic-test.cjs'));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
