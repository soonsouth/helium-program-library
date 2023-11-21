import { useProposal } from "@helium/modular-governance-hooks";
import {
  batchParallelInstructions,
  bulkSendTransactions,
  chunks,
  truthy,
} from "@helium/spl-utils";
import { init, voteMarkerKey } from "@helium/voter-stake-registry-sdk";
import { PublicKey } from "@metaplex-foundation/js";
import { Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useMemo } from "react";
import { useAsyncCallback } from "react-async-hook";
import { useHeliumVsrState } from "../contexts/heliumVsrContext";
import { useVoteMarkers } from "./useVoteMarkers";
import { getRegistrarKey } from "../utils/getPositionKeys";

export const useVote = (proposalKey: PublicKey) => {
  const { info: proposal } = useProposal(proposalKey);
  const { positions, provider, registrar } = useHeliumVsrState();
  const voteMarkerKeys = useMemo(() => {
    return positions
      ? positions.map((p) => voteMarkerKey(p.mint, proposalKey)[0])
      : [];
  }, [positions]);
  const { accounts: markers } = useVoteMarkers(voteMarkerKeys);
  const voteWeights: BN[] | undefined = useMemo(() => {
    if (proposal && markers) {
      return markers.reduce((acc, marker) => {
        marker.info?.choices.forEach((choice) => {
          acc[choice] = (acc[choice] || new BN(0)).add(
            marker.info?.weight || new BN(0)
          );
        });
        return acc;
      }, new Array(proposal?.choices.length));
    }
  }, [proposal, markers]);
  const canVote = useCallback(
    (choice: number) => {
      if (!markers) return false;

      return markers.some((m, index) => {
        const position = positions?.[index];
        const earlierDelegateVoted =
          position &&
          position.votingDelegation &&
          m.info &&
          position.votingDelegation.index > m.info.delegationIndex;
        const noMarker = !m?.info;
        const maxChoicesReached =
          (m?.info?.choices.length || 0) >= (proposal?.maxChoicesPerVoter || 0);
        const alreadyVotedThisChoice = m.info?.choices.includes(choice);
        const canVote =
          noMarker ||
          (!maxChoicesReached &&
            !alreadyVotedThisChoice &&
            !earlierDelegateVoted);
        return canVote;
      });
    },
    [markers]
  );
  const { error, loading, execute } = useAsyncCallback(
    async ({ choice }: { choice: number }) => {
      const isInvalid = !provider || !positions || positions.length === 0;

      if (isInvalid) {
        throw new Error(
          "Unable to vote without positions. Please stake tokens first."
        );
      } else {
        const vsrProgram = await init(provider);
        const instructions = (
          await Promise.all(
            positions.map(async (position, index) => {
              const marker = markers?.[index]?.info;
              const alreadyVotedThisChoice = marker?.choices.includes(choice);
              const maxChoicesReached =
                (marker?.choices.length || 0) >=
                (proposal?.maxChoicesPerVoter || 0);
              if (!marker || (!alreadyVotedThisChoice && !maxChoicesReached)) {
                if (position.isVotingDelegatedToMe) {
                  if (
                    marker &&
                    (marker.delegationIndex <
                      (position.votingDelegation?.index || 0) ||
                      marker.choices.includes(choice))
                  ) {
                    // Do not vote with a position that has been delegated to us, but voting overidden
                    // Also ignore voting for the same choice twice
                    return;
                  }

                  return await vsrProgram.methods
                    .delegatedVoteV0({
                      choice,
                    })
                    .accounts({
                      proposal: proposalKey,
                      owner: provider.wallet.publicKey,
                      position: position.pubkey,
                      registrar: registrar?.pubkey,
                    })
                    .instruction();
                }
                return await vsrProgram.methods
                  .voteV0({
                    choice,
                  })
                  .accounts({
                    proposal: proposalKey,
                    voter: provider.wallet.publicKey,
                    position: position.pubkey,
                  })
                  .instruction();
              }
            })
          )
        ).filter(truthy);

        await batchParallelInstructions(provider, instructions);
      }
    }
  );

  return {
    error,
    loading,
    vote: execute,
    markers,
    voteWeights,
    canVote,
  };
};
