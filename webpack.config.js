//@ts-check

'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const shared = {
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: 'source-map',
  externals: [
    // `vscode` is provided by the extension host at runtime and must stay external.
    // Everything else (including `ssh2`) must be bundled, because the packaged
    // .vsix does not ship node_modules.
    { vscode: 'commonjs vscode' },
    // ssh2 optionally loads native acceleration addons (`cpu-features` and a
    // prebuilt `sshcrypto.node`), each guarded by try/catch with a pure-JS
    // fallback. Webpack can't parse binary `.node` files, so leave these
    // requires external; ssh2 falls back gracefully when they're absent.
    function ({ request }, callback) {
      if (request === 'cpu-features' || /\.node$/.test(request)) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
};

module.exports = [
  {
    ...shared,
    name: 'extension',
    entry: './src/extension.ts',
    output: {
      ...shared.output,
      filename: 'extension.js',
    },
  },
  {
    ...shared,
    name: 'mcp-server',
    entry: './src/mcp/server.ts',
    output: {
      ...shared.output,
      filename: 'mcp-server.js',
    },
  },
];
