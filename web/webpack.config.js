const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const getPort = require("get-port");

module.exports = async (env, argv) => {
  const devPort =
    env && env.WEBPACK_SERVE
      ? await getPort.default({ port: getPort.portNumbers(7000, 7999) })
      : undefined;

  return {
    entry: "./src/index.ts",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "bundle.js",
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
          use: ["style-loader", "css-loader", "postcss-loader"],
        },
      ],
    },
    plugins: [new HtmlWebpackPlugin({ template: "./src/index.html" })],
    resolve: {
      extensions: [".ts", ".js"],
    },
    devServer: {
      static: "./dist",
      port: devPort,
    },
  };
};
