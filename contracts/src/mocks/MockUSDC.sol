// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockUSDC
/// @notice Minimal ERC-20 with 6 decimals and a public faucet for Polygon Amoy testing.
contract MockUSDC {
    string public constant name     = "USD Coin (Test)";
    string public constant symbol   = "USDC";
    uint8  public constant decimals = 6;

    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    // ── Faucet ────────────────────────────────────────────────────────────────

    /// @notice Mint test USDC to any address — public faucet for testnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ── ERC-20 ────────────────────────────────────────────────────────────────

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockUSDC: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    function _mint(address to, uint256 amount) internal {
        totalSupply        += amount;
        balanceOf[to]      += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "MockUSDC: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
