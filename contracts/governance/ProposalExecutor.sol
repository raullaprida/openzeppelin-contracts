// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {TimelockController} from "./TimelockController.sol";

contract ProposalExecutor {
    TimelockController[] private _proposalTimelocks; //The position in the array is the proposal type
    mapping(uint256 proposalId => bytes32) private _timelockIds;
    mapping(address => bool) private _existingTimelocks;

    uint256 private _currentProposalTypes;

    constructor(TimelockController[] memory _proposalTimelcks) {
        _proposalTimelocks = _proposalTimelcks;
        _currentProposalTypes = _proposalTimelcks.length;

        // Check that a bucket is not being assigned to multiple proposal types
        for (uint256 i = 0; i < _proposalTimelcks.length; i++) {
            address timelock = address(_proposalTimelcks[i]);
            require(!_existingTimelocks[timelock], "Duplicate timelock");
            _existingTimelocks[timelock] = true;
        }
    }

    function isAddressInProposalTimelocks(address _address) external view returns (bool) {
        return _existingTimelocks[_address];
    }

    function _getTimelock(uint256 proposalType) internal view returns (TimelockController) {
        require(proposalType <= _currentProposalTypes - 1, "Invalid proposal type");

        return _proposalTimelocks[proposalType];
    }

    /**
     * @dev Returns whether an operation is pending or not. Note that a "pending" operation may also be "ready".
     */
    function isOperationPending(uint256 proposalId, uint256 proposalType) public view returns (bool) {
        return _getTimelock(proposalType).isOperationPending(_timelockIds[proposalId]);
    }

    function isOperationDone(uint256 proposalId, uint256 proposalType) public view returns (bool) {
        return _getTimelock(proposalType).isOperationDone(_timelockIds[proposalId]);
    }

    function getMinDelay(uint256 proposalType) public view returns (uint256) {
        return _getTimelock(proposalType).getMinDelay();
    }

    /**
     * @dev Returns the identifier of an operation containing a batch of
     * transactions.
     */
    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 proposalId,
        uint256 proposalType
    ) public virtual returns (uint256) {
        TimelockController _timelock = _getTimelock(proposalType);
        uint256 delay = _timelock.getMinDelay();
        _timelockIds[proposalId] = _timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
        _timelock.scheduleBatch(targets, values, payloads, 0, salt, delay);
        return delay;
    }

    // slither-disable-next-line reentrancy-eth
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 proposalId,
        uint256 proposalType
    ) public payable {
        _getTimelock(proposalType).executeBatch(targets, values, payloads, predecessor, salt);
        delete _timelockIds[proposalId];
    }

    function cancel(uint256 proposalId, uint256 proposalType) public {
        bytes32 timelockId = _timelockIds[proposalId];

        if (timelockId != 0) {
            _getTimelock(proposalType).cancel(timelockId);
            delete _timelockIds[proposalId];
        }
    }
}
