// config.js
module.exports = {
  depositAddresses: {
    BTC: "14ycZDE2g5hcfxUFbVRWGXT8gD6mHtgQP3",
    ETH: "0x239aD5B0560dD6844eb0dF6A1a42d1178B341614",
    USDT: "TWiC9WSSdoipJRygDeji3grAWLvQTcR58t",
    TRX: "TDTbrhxQ5EZihHphgNgYBrsxSkUVPCzKRx",
    LTC: "LZxqXy45zQ6c4Xx8Yq4Y8cWqYq4Y8cWqYq",
    XRP: "rM2rRB5amj1BPdGourT2aqPY2BFZtbjYcy",
    TON: "UQDvieXNcjzZeqAUE5kczKVs6kQDp9hYU2fp4kot73DHEX2W",
    SOL: "HdMf5nLg2pFERhUBAUfzUhR597ynetjRmNUzJRKNkReT",
    DOGE: "DTf78w8f7KKBtdhxe7coQRSYLvcmXZm6SA",
  },
  addressValidators: {
    // Legacy (1,3) and Bech32 (bc1…) mainnet Bitcoin addresses only
    BTC: (addr) =>
      /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,59})$/.test(
        addr,
      ),

    // Ethereum mainnet (~0x + 40 hex)
    ETH: (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr),

    // USDT on Ethereum (ERC-20) same format as ETH
    USDT: (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr),

    // Tron mainnet (base58, starts with T, 34 chars)
    TRX: (addr) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr),

    // Litecoin: Legacy (L,M) and Bech32 (ltc1…)
    LTC: (addr) =>
      /^(?:L[a-km-zA-HJ-NP-Z1-9]{26,33}|M[a-km-zA-HJ-NP-Z1-9]{26,33}|ltc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,59})$/.test(
        addr,
      ),

    // Ripple classic addresses (starts with r, 25–35 chars)
    XRP: (addr) => /^r[0-9A-Za-z]{24,34}$/.test(addr),

    // TON addresses (base64 URL-safe, 48–52 chars) — naive check
    TON: (addr) => /^[-_A-Za-z0-9]{48,52}$/.test(addr),

    // Solana public keys (base58, 32–44 chars)
    SOL: (addr) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr),

    // Dogecoin legacy (starts with D, 34 chars) and P2SH (starts with A)
    DOGE: (addr) => /^[DA][A-Za-z0-9]{33}$/.test(addr),
  },
};
