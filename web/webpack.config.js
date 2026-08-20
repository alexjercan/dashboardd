const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const getPort = require("get-port");
const fs = require("fs");

class SurfaceStylesPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("SurfaceStylesPlugin", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "SurfaceStylesPlugin",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          compilation.emitAsset(
            "surface.css",
            new compiler.webpack.sources.RawSource(
              fs.readFileSync(path.resolve(__dirname, "src/surface.css")),
            ),
          );
        },
      );
    });
  }
}

module.exports = async (env, argv) => {
  const devPort =
    env && env.WEBPACK_SERVE
      ? await getPort.default({ port: getPort.portNumbers(7000, 7999) })
      : undefined;

  return {
    entry: {
      bundle: "./src/index.ts",
      surface: "./src/surface.ts",
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
        template: "./src/index.html",
        filename: "index.html",
        chunks: ["bundle"],
      }),
      new HtmlWebpackPlugin({
        template: "./src/surface.html",
        filename: "surface.html",
        chunks: ["surface"],
      }),
      new SurfaceStylesPlugin(),
    ],
    resolve: {
      extensions: [".ts", ".js"],
    },
    devServer: {
      static: "./dist",
      port: devPort,
    },
  };
};
