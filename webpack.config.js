const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/renderer/index.tsx',
  target: 'electron-renderer',
  output: {
    path: path.resolve(__dirname, 'lib/renderer'),
    filename: 'index.js',
    libraryTarget: 'commonjs2',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json',
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  // NOTE: do NOT add 'react-router-dom' here. The add-on bundle is loaded by a
  // plain Node require() from the installed add-on directory (outside Local's
  // app.asar), so any external left in the bundle must be resolvable there on a
  // clean install — i.e. provided by Local's loader and a real package, or one
  // of our bundledDependencies. react-router-dom is neither (devDependency
  // only), so we consume it via context.ReactRouter instead. See
  // src/renderer/bundle.packaging.test.ts.
  externals: {
    react: 'react',
    'react-dom': 'react-dom',
    '@getflywheel/local': '@getflywheel/local',
    '@getflywheel/local-components': '@getflywheel/local-components',
  },
};
