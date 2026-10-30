import CopyWebpackPlugin from 'copy-webpack-plugin';
import webpack, { type Configuration, type RuleSetRule } from 'webpack';

import grafanaConfig, { type Env } from './.config/webpack/webpack.config.ts';

// The plugin is one module.js next to plugin.json, logo.svg and LICENSE (plus a source map that is not
// released). The scaffold's own copy step is replaced because it would also copy the test fixtures.
const config = async (env: Env): Promise<Configuration> => {
  const base = await grafanaConfig(env);
  const rules = (base.module?.rules ?? []).map((rule) => {
    if (!rule || typeof rule !== 'object' || rule.type !== 'asset/resource') {
      return rule;
    }
    // Inline imported images and fonts instead of emitting hashed files.
    const { generator: _generator, ...inline } = rule as RuleSetRule;
    return { ...inline, type: 'asset/inline' };
  });

  return {
    ...base,
    module: { ...base.module, rules },
    optimization: { ...base.optimization, splitChunks: false },
    plugins: [
      ...(base.plugins ?? []).filter((plugin) => !(plugin instanceof CopyWebpackPlugin)),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'plugin.json', to: '.' },
          { from: 'logo.svg', to: '.' },
          { from: '../LICENSE', to: '.' },
        ],
      }),
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
  };
};

export default config;
