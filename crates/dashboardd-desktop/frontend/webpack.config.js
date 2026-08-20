const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
  entry: {
    surface: "./src/surface.ts",
    launcher: "./src/launcher.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    publicPath: "/",
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "./src/surface.html",
      filename: "index.html",
      chunks: ["surface"],
    }),
    new HtmlWebpackPlugin({
      template: "./src/launcher.html",
      filename: "launcher.html",
      chunks: ["launcher"],
    }),
  ],
  resolve: {
    extensions: [".ts", ".js"],
  },
};
