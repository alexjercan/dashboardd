const path = require("path");

module.exports = (_env, argv) => ({
  entry: {
    full: "./src/full.ts",
    compact: "./src/compact.ts",
    minimal: "./src/minimal.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  devtool: argv.mode === "development" ? "source-map" : false,
  optimization: { runtimeChunk: false, splitChunks: false },
  module: {
    rules: [
      { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ },
      { test: /\.css$/, type: "asset/source" },
    ],
  },
  resolve: { extensions: [".ts", ".js"] },
});
