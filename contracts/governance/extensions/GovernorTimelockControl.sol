// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (governance/extensions/GovernorTimelockControl.sol)

pragma solidity ^0.8.20;

import {IGovernor, Governor} from "../Governor.sol";
import {TimelockController} from "../TimelockController.sol";
import {IERC165} from "../../interfaces/IERC165.sol";
import {SafeCast} from "../../utils/math/SafeCast.sol";
import {ProposalExecutor} from "../ProposalExecutor.sol";

/**
 * @dev Extension of {Governor} that binds the execution process to an instance of {TimelockController}. This adds a
 * delay, enforced by the {TimelockController} to all successful proposal (in addition to the voting duration). The
 * {Governor} needs the proposer (and ideally the executor and canceller) roles for the {Governor} to work properly.
 *
 * Using this model means the proposal will be operated by the {TimelockController} and not by the {Governor}. Thus,
 * the assets and permissions must be attached to the {TimelockController}. Any asset sent to the {Governor} will be
 * inaccessible from a proposal, unless executed via {Governor-relay}.
 *
 * WARNING: Setting up the TimelockController to have additional proposers or cancellers besides the governor is very
 * risky, as it grants them the ability to: 1) execute operations as the timelock, and thus possibly performing
 * operations or accessing funds that are expected to only be accessible through a vote, and 2) block governance
 * proposals that have been approved by the voters, effectively executing a Denial of Service attack.
 */
abstract contract GovernorTimelockControl is Governor {
    ProposalExecutor private _executorRouter;

    /**
     * @dev Emitted when the timelock controller used for proposal execution is modified.
     */
    event ExecutorChange(address oldExecutor, address newExecutor);

    /**
     * @dev Set the timelock.
     */
    constructor(ProposalExecutor executorAddress) {
        _updateExecutor(executorAddress);
    }

    /**
     * @dev Overridden version of the {Governor-state} function that considers the status reported by the timelock.
     */
    function state(uint256 proposalId) public view virtual override returns (ProposalState) {
        ProposalState currentState = super.state(proposalId);

        if (currentState != ProposalState.Queued) {
            return currentState;
        }

        uint8 proposalType = super.proposalType(proposalId);

        if (_executorRouter.isOperationPending(proposalId, proposalType)) {
            return ProposalState.Queued;
        } else if (_executorRouter.isOperationDone(proposalId, proposalType)) {
            // This can happen if the proposal is executed directly on the timelock.
            return ProposalState.Executed;
        } else {
            // This can happen if the proposal is canceled directly on the timelock.
            return ProposalState.Canceled;
        }
    }

    /**
     * @dev Public accessor to check the address of the timelock
     */
    function timelock() public view virtual returns (address) {
        return address(_executorRouter);
    }

    /**
     * @dev See {IGovernor-proposalNeedsQueuing}.
     */
    function proposalNeedsQueuing(uint256) public view virtual override returns (bool) {
        return true;
    }

    /**
     * @dev Function to queue a proposal to the timelock.
     */
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal virtual override returns (uint48) {
        bytes32 salt = _timelockSalt(descriptionHash);
        uint8 proposalType = super.proposalType(proposalId);
        uint256 delay = _executorRouter.scheduleBatch(targets, values, calldatas, 0, salt, proposalId, proposalType);

        return SafeCast.toUint48(block.timestamp + delay);
    }

    /**
     * @dev Overridden version of the {Governor-_executeOperations} function that runs the already queued proposal
     * through the timelock.
     */
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal virtual override {
        // execute
        _executorRouter.executeBatch{value: msg.value}(
            targets,
            values,
            calldatas,
            0,
            _timelockSalt(descriptionHash),
            proposalId,
            super.proposalType(proposalId)
        );
    }

    /**
     * @dev Address through which the governor executes action. Will be overloaded by module that execute actions
     * through another contract such as a timelock.
     */
    function _executor() internal view virtual override returns (address) {
        return address(_executorRouter);
    }

    /**
     * @dev Overridden version of the {Governor-_cancel} function to cancel the timelocked proposal if it has already
     * been queued.
     */
    // This function can reenter through the external call to the timelock, but we assume the timelock is trusted and
    // well behaved (according to TimelockController) and this will not happen.
    // slither-disable-next-line reentrancy-no-eth
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash,
        uint8 proposalType
    ) internal virtual override returns (uint256) {
        uint256 proposalId = super._cancel(targets, values, calldatas, descriptionHash, proposalType);

        _executorRouter.cancel(proposalId, proposalType);

        return proposalId;
    }

    function _isExecutor() internal view virtual override returns (bool) {
        return _executorRouter.isAddressInProposalTimelocks(_msgSender());
    }

    /**
     * @dev Public endpoint to update the underlying timelock instance. Restricted to the timelock itself, so updates
     * must be proposed, scheduled, and executed through governance proposals.
     *
     * CAUTION: It is not recommended to change the timelock while there are other queued governance proposals.
     */
    function updateExecutor(ProposalExecutor newExecutor) external virtual onlyGovernance {
        _updateExecutor(newExecutor);
    }

    function _updateExecutor(ProposalExecutor newExecutor) private {
        emit ExecutorChange(address(_executorRouter), address(newExecutor));
        _executorRouter = newExecutor;
    }

    /**
     * @dev Computes the {TimelockController} operation salt.
     *
     * It is computed with the governor address itself to avoid collisions across governor instances using the
     * same timelock.
     */
    function _timelockSalt(bytes32 descriptionHash) private view returns (bytes32) {
        return bytes20(address(this)) ^ descriptionHash;
    }
}
