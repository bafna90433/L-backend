const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyPieceRecords } = require('../production-rules');
const entry = (date, labourId, pieces, minutes = 480, extra = {}) => ({ date, labourId, toyId: 'hen', processId: 'body', pieces, minutes, ...extra });

test('daily quantity replaces 500 with 600 even for the same holder and a lower hourly rate', () => {
  const result = dailyPieceRecords([entry('2026-10-01', 'a', 500, 240), entry('2026-10-02', 'a', 600, 600), entry('2026-10-03', 'b', 590, 60)]);
  assert.equal(result.board.length, 1);
  assert.equal(result.board[0].pieces, 600);
  assert.equal(result.board[0].workerId, 'a');
  assert.equal(result.board[0].attempts, 3);
  assert.equal(result.broken[0].previousPieces, 500);
});

test('split work sums within one worker/day/job; ties, training and independent jobs are handled', () => {
  const result = dailyPieceRecords([
    entry('2026-10-01', 'a', 250, 120), entry('2026-10-01', 'a', 350, 120),
    entry('2026-10-02', 'b', 600), entry('2026-10-03', 'b', 900, 480, { isTraining: true }),
    entry('2026-10-04', 'b', 800, 480, { toyId: 'duck' }),
    entry('2026-10-04', 'a', 50, 30, { processId: 'head' })
  ]);
  assert.equal(result.board.length, 3);
  const hen = result.board.find(row => row.toyId === 'hen' && row.processId === 'body');
  assert.equal(hen.workerId, 'a'); assert.equal(hen.pieces, 600); assert.equal(hen.attempts, 2);
  assert.equal(result.broken.length, 0);
});


test('daily personal improvements name the best earlier other worker, excluding training and unrelated work', () => {
  const result=dailyPieceRecords([
    entry('2026-10-01','b',400),entry('2026-10-02','a',500),
    entry('2026-10-03','c',900,480,{processId:'head'}),
    entry('2026-10-04','d',950,480,{isTraining:true}),
    entry('2026-10-05','a',600),entry('2026-10-06','e',590)
  ]);
  const current=result.broken.find(row=>row.date==='2026-10-05');
  assert.equal(current.workerId,'a');assert.equal(current.competitorWorkerId,'b');
  assert.equal(current.competitorPieces,400);assert.equal(current.competitorDate,'2026-10-01');
  const alone=dailyPieceRecords([entry('2026-10-01','a',500),entry('2026-10-02','a',600)]).broken[0];
  assert.equal(alone.competitorWorkerId,undefined);assert.equal(alone.previousPieces,500);
});
