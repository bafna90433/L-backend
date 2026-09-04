const test = require('node:test');
const assert = require('node:assert/strict');

const { Task } = require('../mongo-models');

test('stores completion requests separately from the final task status', () => {
  const task = new Task({
    title: 'Approval workflow task',
    assignedTo: '507f1f77bcf86cd799439011',
    completionRequestedBy: '507f191e810c19729de860ea',
    completionRequestedAt: new Date('2026-09-04T03:15:00.000Z')
  });

  assert.equal(task.status, 'pending');
  assert.equal(String(task.completionRequestedBy), '507f191e810c19729de860ea');
  assert.equal(task.completionRequestedAt.toISOString(), '2026-09-04T03:15:00.000Z');
  assert.equal(task.completedAt, null);
});
