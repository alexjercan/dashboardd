const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
  entry: "./src/surface.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "surface.js",
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
  plugins: [new HtmlWebpackPlugin({ template: "./src/surface.html" })],
  resolve: {
    extensions: [".ts", ".js"],
  },
};
