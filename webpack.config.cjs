const path = require("path");
const zlib = require("zlib");
const CompressionPlugin = require("compression-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const CssMinimizerPlugin = require("css-minimizer-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = (_env, argv) => {
  const isProduction = argv.mode === "production";

  return {
    context: __dirname,
    entry: {
      app: "./app.js",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: isProduction ? "assets/[name].[contenthash:12].js" : "assets/[name].js",
      chunkFilename: isProduction ? "assets/[name].[contenthash:12].js" : "assets/[name].js",
      assetModuleFilename: "assets/[name].[contenthash:12][ext][query]",
      clean: true,
    },
    devtool: isProduction ? "source-map" : "eval-source-map",
    module: {
      rules: [
        {
          test: /\.css$/i,
          use: [MiniCssExtractPlugin.loader, "css-loader"],
        },
        {
          test: /\.(woff2?|ttf|eot)$/i,
          type: "asset/resource",
          generator: {
            filename: "assets/fonts/[name].[contenthash:12][ext]",
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./index.html",
        scriptLoading: "defer",
        minify: isProduction
          ? {
              collapseWhitespace: true,
              keepClosingSlash: true,
              minifyCSS: true,
              minifyJS: true,
              removeComments: true,
              removeRedundantAttributes: true,
              removeScriptTypeAttributes: true,
              removeStyleLinkTypeAttributes: true,
              useShortDoctype: true,
            }
          : false,
      }),
      new MiniCssExtractPlugin({
        filename: isProduction ? "assets/[name].[contenthash:12].css" : "assets/[name].css",
        chunkFilename: isProduction ? "assets/[name].[contenthash:12].css" : "assets/[name].css",
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "assets", to: "assets" },
          {
            from: "sw.js",
            to: "sw.js",
            // The deployment's map build id (scripts/build_webapp.sh), which
            // renames the tile cache whenever the tiles were redrawn -- see
            // MAP_BUILD_ID in sw.js. Empty outside a deployment build.
            transform: (content) =>
              content
                .toString()
                .replace(
                  "__DEMSCORE_MAP_BUILD_ID__",
                  (process.env.DEMSCORE_MAP_BUILD_ID || "").replace(/[^A-Za-z0-9-]/g, ""),
                ),
          },
        ],
      }),
      ...(isProduction
        ? [
            new CompressionPlugin({
              test: /\.(html|css|js)$/i,
              algorithm: "gzip",
              filename: "[path][base].gz",
              threshold: 0,
              minRatio: 1,
            }),
            new CompressionPlugin({
              test: /\.(html|css|js)$/i,
              algorithm: "brotliCompress",
              filename: "[path][base].br",
              compressionOptions: {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
                },
              },
              threshold: 0,
              minRatio: 1,
            }),
          ]
        : []),
    ],
    optimization: {
      minimize: isProduction,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            format: {
              comments: false,
            },
          },
          extractComments: false,
        }),
        new CssMinimizerPlugin(),
      ],
      splitChunks: {
        chunks: "all",
      },
    },
    devServer: {
      static: {
        directory: path.resolve(__dirname, "dist"),
      },
      historyApiFallback: true,
      proxy: [
        {
          context: ["/api", "/healthz", "/mapserver"],
          target: "http://127.0.0.1:8090",
          changeOrigin: true,
        },
      ],
    },
  };
};
