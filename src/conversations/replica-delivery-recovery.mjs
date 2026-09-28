export function createReplicaDeliveryRecovery({ loadConversations, publicConversation, publicTurn, message }) {
  // Startup-only reconciliation of the delivery owner's outstanding attempts.
  // Conversation storage owns completion evidence; callers never read its files.
  return function recoverReplicaDelivery(sourceCollaboratorId, deliveryId, epoch) {
    const ownerId = `mobilereplica_${sourceCollaboratorId}`;
    if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) throw new Error("invalid replica recovery identity");
    const conversation = loadConversations(ownerId, true).find((item) =>
      item.activeTurn?.source === "mobile-replica-proactive"
      && item.activeTurn.deliveryId === deliveryId
      && item.activeTurn.executionEpoch === epoch
      && item.activeTurn.state === "completed");
    if (!conversation) return null;
    const turn = conversation.activeTurn;
    const assistant = message(conversation, turn.assistantMessageId);
    if (!assistant || assistant.status !== "completed") return null;
    return { outcome: "completed", failure: null,
      conversation: publicConversation(conversation, true),
      turn: publicTurn(turn), assistantMessage: { ...assistant } };
  }

}
