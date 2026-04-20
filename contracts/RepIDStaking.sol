// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IIdentityRegistry {
    function getReputation(uint256 agentId) 
        external view returns (uint256);
}

contract RepIDStaking {
    IIdentityRegistry public identityRegistry;
    
    struct Stake {
        address staker;
        uint256 agentId;
        uint256 amount;
        uint256 decisionHash;
        uint8 status; // 0=pending, 1=approved, 2=slashed
        uint256 stakedAt;
    }
    
    mapping(uint256 => Stake) public stakes;
    uint256 public stakeCount;
    uint256 public constant MIN_STAKE = 0.0001 ether;
    
    event Staked(uint256 indexed stakeId, uint256 agentId, 
                 uint256 amount, uint256 decisionHash);
    event Approved(uint256 indexed stakeId, uint256 agentId);
    event Slashed(uint256 indexed stakeId, uint256 agentId, 
                  uint256 amount);
    
    constructor(address _registry) {
        identityRegistry = IIdentityRegistry(_registry);
    }
    
    function stake(uint256 agentId, uint256 decisionHash) 
        external payable {
        require(msg.value >= MIN_STAKE, "Stake too small");
        uint256 stakeId = ++stakeCount;
        stakes[stakeId] = Stake({
            staker: msg.sender,
            agentId: agentId,
            amount: msg.value,
            decisionHash: decisionHash,
            status: 0,
            stakedAt: block.timestamp
        });
        emit Staked(stakeId, agentId, msg.value, decisionHash);
    }
    
    function approve(uint256 stakeId) external {
        Stake storage s = stakes[stakeId];
        require(s.status == 0, "Not pending");
        s.status = 1;
        payable(s.staker).transfer(s.amount);
        emit Approved(stakeId, s.agentId);
    }
    
    function slash(uint256 stakeId) external {
        Stake storage s = stakes[stakeId];
        require(s.status == 0, "Not pending");
        s.status = 2;
        uint256 amount = s.amount;
        s.amount = 0;
        // Slashed funds go to contract (insurance pool)
        emit Slashed(stakeId, s.agentId, amount);
    }
    
    function getStake(uint256 stakeId) 
        external view returns (Stake memory) {
        return stakes[stakeId];
    }
    
    receive() external payable {}
}
