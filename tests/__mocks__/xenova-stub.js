module.exports = {
  pipeline: async () => async () => ({ data: new Float32Array() }),
  env: { allowLocalModels: false }
};
