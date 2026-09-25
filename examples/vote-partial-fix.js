// Raft vote handling for one node (simplified from etcd raft.go).
export function handleVoteRequest(node, msg) {
  if (msg.term > node.term) {
    node.term = msg.term;
    node.role = 'follower';
    node.votedFor = null;
    node.leader = null;
  }
  if (msg.term < node.term) return { granted: false, term: node.term };
  const canVote = node.votedFor === msg.from || (node.votedFor === null && node.leader === null);
  const lastIndex = node.log.length;
  const lastTerm = lastIndex ? node.log[lastIndex - 1].term : 0;
  const upToDate = msg.lastTerm > lastTerm || (msg.lastTerm === lastTerm && msg.lastIndex >= lastIndex);
  if (canVote && upToDate) {
    node.votedFor = msg.from;
    node.electionElapsed = 0;
    return { granted: true, term: node.term };
  }
  return { granted: false, term: node.term };
}

export async function onMessage(node, msg, lock) {
  await lock.acquire();
  try {
    if (msg.type === 'vote') return handleVoteRequest(node, msg);
    if (msg.type === 'heartbeat' && msg.term >= node.term) { node.leader = msg.from; node.electionElapsed = 0; }
  } finally { lock.release(); }
}
