const path = require("path");

module.exports = (_env, argv) => ({
  entry: {
    pulse: "./src/pulse.ts",
    brief: "./src/brief.ts",
    "brief-launcher": "./src/brief-launcher.ts",
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
