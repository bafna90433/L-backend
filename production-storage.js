const { AsyncLocalStorage } = require('node:async_hooks');
const sessions = new AsyncLocalStorage();

// Only production operations opt into Mongo sessions; unrelated app routes retain
// their existing provider behaviour. Queries, mutations and audit share a session.
function productionModels(models) {
  if ((process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase() === 'postgresql') return models;
  return Object.fromEntries(Object.entries(models).map(([name, model]) => [name, new Proxy(model, {
    get(target, method) {
      const original = target[method];
      if (typeof original !== 'function') return original;
      return (...args) => {
        const session = sessions.getStore();
        if (!session) return original.apply(target, args);
        if (method === 'create') return target.create([args[0]], { session }).then(rows => rows[0]);
        const result = original.apply(target, args);
        return result?.session ? result.session(session) : result;
      };
    }
  })]));
}
async function transaction(work) {
  if ((process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase() === 'postgresql') return require('./postgres-models').withProductionTransaction(work);
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => sessions.run(session, work));
  } catch (error) {
    if (error.code === 20 || /Transaction numbers are only allowed/.test(error.message)) {
      throw Object.assign(new Error('Production writes require MongoDB replica-set transactions. No change was saved.'), { statusCode: 503 });
    }
    throw error;
  } finally { await session.endSession(); }
}
module.exports = { productionModels, transaction };
