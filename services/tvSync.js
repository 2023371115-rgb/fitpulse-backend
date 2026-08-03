const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

const userState = new Map();

function getState(userId) {
  return userState.get(userId) || {
    selectedIndex: 0,
    selectedCardId: 'steps',
    lastAction: 'Sistema listo',
    updatedAt: new Date().toISOString()
  };
}

function setState(userId, patch) {
  const current = getState(userId);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  userState.set(userId, next);
  bus.emit(`user:${userId}`, next);
  return next;
}

function subscribe(userId, listener) {
  const eventName = `user:${userId}`;
  bus.on(eventName, listener);
  return () => bus.off(eventName, listener);
}

module.exports = { getState, setState, subscribe };
