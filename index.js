const ethers = require('ethers');
const axios = require('axios');
const { Client, Intents, MessageEmbed } = require('discord.js');
const ABI = require('./abi');

const Redis = require('ioredis');
let redis_url = process.env.REDIS_TLS_URL;
let redisOptions = {
  tls: { rejectUnauthorized: false },
};

if (process.env.ENVIRONMENT !== 'production') {
  redisOptions = {};
  redis_url = 'redis://127.0.0.1';
  require('dotenv').config();
}

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  MINT_CHANNEL_ID,
  OPENSEA_KEY,
  COLLECTION_SLUG,
  ENS_PROVIDER_URL,
  AUTHOR_NAME,
  AUTHOR_THUMBNAIL,
  AUTHOR_URL,
  LISTING_CHANNEL_ID,
} = process.env;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const fetchOptions = {
  headers: { 'x-api-key': OPENSEA_KEY },
};
const ensprovider = new ethers.providers.JsonRpcProvider(ENS_PROVIDER_URL);
const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL);

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  ABI,
  provider
);
provider.pollingInterval = 30000;

// Create a new client instance
const client = new Client({ intents: [Intents.FLAGS.GUILDS] });
let redisClient;
let listingChannel;

// When the client is ready, run this code (only once)
client.once('ready', async () => {
  console.log('Ready!');
  console.log(`Watching ${COLLECTION_SLUG}`);
  // console.log(`Watching ${await contract.name()}`);
  const channel = await client.channels.fetch(CHANNEL_ID);
  const mintChannel = MINT_CHANNEL_ID
    ? await client.channels.fetch(MINT_CHANNEL_ID)
    : channel;

  listenForSales(channel, mintChannel);
  if (LISTING_CHANNEL_ID) {
    listingChannel = await client.channels.fetch(LISTING_CHANNEL_ID);
    redisClient = new Redis(redis_url, redisOptions);
    pollListings(true);
  }
});

client.on('error', function (error) {
  console.error(`client's WebSocket encountered a connection error: ${error}`);
});

function osLink(chain, nft) {
  return `https://opensea.io/assets/${chain}/${nft.contract}/${nft.identifier}`;
}
async function getOpenSeaName(address) {
  const response = await axios
    .get(`https://api.opensea.io/api/v2/accounts/${address}`, fetchOptions)
    .catch(() => false);
  let username;

  if (
    !response ||
    !response.data ||
    response.data.username === 'null' ||
    response.data.username === null ||
    response.data.username.length === 0
  ) {
    username = await getENSName(address);
  } else {
    username = response.data.username;
    username = `[${username}](https://opensea.io/${username})`;
  }
  return username;
}
async function getENSName(address) {
  let name = await ensprovider.lookupAddress(address).catch(() => false);
  if (!name) {
    name = address.substr(0, 10);
  }
  return `[${name}](https://opensea.io/${address})`;
}

async function getBalance(address, id) {
  if (!address) {
    return '?';
  }
  let balance;
  console.log(`checking balance of ${address}`);
  try {
    balance = await contract['balanceOf(address)'](address);
  } catch (e) {
    console.log(`Err! ${e}`);
    try {
      console.log(`Error! checking balance of ${address}, ${id}`);
      balance = await contract['balanceOf(address,uint256)'](
        address,
        parseInt(id, 10)
      );
    } catch (e) {
      console.log(`Err! ${e}`);
    }
  }
  return balance || 0;
}

async function mint(toAddress, value, channel, count, gasPrice, gasUsed) {
  count = count || 0;
  const tokenId = value;
  const tokenURI = await contract.tokenURI(value);
  const totalSupply = (await contract.totalSupply()).toNumber();
  // todo: make this work for JSON tokenURI's
  console.log(`MintBot fetching ${tokenURI}`);
  const response = await axios
    .get(tokenURI.replace('ipfs://', 'https://0x420.mypinata.cloud/ipfs/'))
    .catch((error) => {
      console.log(`error fetching tokenURI: ${tokenURI}`);
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.log(error.response.data);
        console.log(error.response.status);
        console.log(error.response.headers);
      } else if (error.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        console.log(error.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        console.log('Error', error.message);
      }
      return false;
    });
  if (!response) {
    console.log('Error fetching token metadata');
    if (count < 30) {
      console.log(`Checking ${value} again in 5 seconds. ${count} / 30`);
      setTimeout(() => {
        mint(toAddress, value, channel, count + 1, gasPrice, gasUsed);
      }, 5000);
    } else {
      console.log(`Giving up on ${value}`);
    }
    return;
  }
  const token = response.data;
  const image = token.image.replace(
    'ipfs://',
    'https://0x420.mypinata.cloud/ipfs/'
  );
  const fields = [
    {
      name: 'Minter',
      value: `${await getOpenSeaName(toAddress)}`,
      inline: true,
    },
    {
      name: 'Minter Holds',
      value: `${(await getBalance(toAddress, value)).toLocaleString()}`,
      inline: true,
    },
    { name: 'Total Supply', value: totalSupply.toLocaleString(), inline: true },
  ];
  if (token.attributes) {
    token.attributes.forEach((attr) => {
      fields.push({
        name: attr.trait_type,
        value: attr.value,
        inline: true,
      });
    });
  }

  // if (gasPrice && gasUsed) {
  //   fields.push({
  //     name: 'Gas Price',
  //     value: `${gasPrice} Gwei`,
  //     inline: true,
  //   });
  //   fields.push({
  //     name: 'Gas Spent',
  //     value: `${String(gasUsed.substring(0, 7))} Ether`,
  //     inline: true,
  //   });
  // }
  const embed = new MessageEmbed()
    .setColor(token.background_color || '#0099ff')
    .setURL(
      `https://opensea.io/assets/ethereum/${process.env.CONTRACT_ADDRESS}/${tokenId}`
    ) // todo this needs to handle /matic/
    .setTitle(token.name + ' minted!')
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(AUTHOR_THUMBNAIL)
    .addFields(fields)
    .setImage(image)
    .setTimestamp();
  channel.send({ embeds: [embed] });
}

const buildMessage = async (sale, gasPrice, gasUsed) => {
  const fields = [
    {
      name: 'Buyer',
      value: `${await getOpenSeaName(sale.buyer)}`,
      inline: true,
    },
    {
      name: 'Buyer Holds',
      value: `${(
        await getBalance(sale.buyer, sale.nft.identifier)
      ).toLocaleString()}`,
      inline: true,
    },
    {
      name: 'Price',
      value: `${ethers.utils.formatEther(BigInt(sale.payment.quantity || 0))}${
        sale.payment.symbol
      }`,
      inline: true,
    },
    // { name: '\u200B', value: '\u200B', inline: true },
    {
      name: 'Seller',
      value: `${await getOpenSeaName(sale.seller)}`,
      inline: true,
    },
    {
      name: 'Seller Holds',
      value: `${(
        await getBalance(sale.seller, sale.nft.identifier)
      ).toLocaleString()}`,
      inline: true,
    },
  ];
  // if (gasPrice && gasUsed) {
  //   fields.push({
  //     name: 'Gas Price',
  //     value: `${gasPrice} Gwei`,
  //     inline: true,
  //   });
  //   fields.push({
  //     name: 'Gas Spent',
  //     value: `${gasUsed} Ether`,
  //     inline: true,
  //   });
  // }

  return new MessageEmbed()
    .setColor('#0099ff')
    .setTitle(sale.nft.name + ' sold!')
    .setURL(osLink(sale.chain, sale.nft))
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(sale.nft.imge_url)
    .addFields(fields)
    .setImage(sale.nft.image_url)
    .setTimestamp(new Date(sale.closing_date * 1000))
    .setFooter(
      'Sold on OpenSea (v2)',
      'https://files.readme.io/566c72b-opensea-logomark-full-colored.png'
    );
};

async function searchForToken(
  token,
  from,
  to,
  channel,
  count,
  gasPrice,
  gasUsed
) {
  count = count || 0;
  console.log(`Searching for token: ${token} attempt: ${count}`);
  let found = false;
  const params = new URLSearchParams({
    event_type: 'sale',
  });
  console.log('With params:', params);

  const openSeaResponseObject = await axios
    .get(
      `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}?` +
        params,
      fetchOptions
    )
    .catch((e) => {
      console.log('ERRRRR');
      console.log(e);
    });
  if (openSeaResponseObject && openSeaResponseObject.data) {
    const openSeaResponse = openSeaResponseObject.data;
    if (!openSeaResponse.asset_events) {
      console.log('no asset_events');
    }
    if (openSeaResponse.asset_events) {
      openSeaResponse.asset_events.forEach((event) => {
        if (event.nft) {
          console.log(
            `Comparing ${token} to ${event.nft.identifier}, to: ${to}, winner: ${event.buyer}`
          );
          if (
            event.nft.identifier === token &&
            to.toLowerCase() === event.buyer.toLowerCase()
          ) {
            found = event;
          }
        } else {
          console.log('Strange event', event);
        }
      });
      if (found && found.buyer) {
        const embed = await buildMessage(found, gasPrice, gasUsed);
        channel.send({ embeds: [embed] });
      }
    }
  }
  if (!found && count < 30) {
    setTimeout(() => {
      searchForToken(token, from, to, channel, count + 1, gasPrice, gasUsed);
    }, count * count * 1000);
  }
}

// function keepAlive() {
//   contract.name().then((r) => {
//     // console.log(`Keep Alive for ${r}`);
//   });
// }

function listenForSales(channel, mintChannel) {
  contract.on('Transfer', async (fromAddress, toAddress, value, event) => {
    const receipt = await event.getTransactionReceipt();
    const gasPrice = ethers.utils.formatUnits(
      receipt.effectiveGasPrice,
      'gwei'
    );
    const gasUsed = ethers.utils.formatUnits(
      receipt.gasUsed.mul(receipt.effectiveGasPrice),
      'ether'
    );

    console.log(
      `Token ${value} Transferred from ${fromAddress} to ${toAddress}`
    );
    if (fromAddress === ZERO_ADDRESS) {
      mint(toAddress, value, mintChannel, 0, gasPrice, gasUsed);
    } else if (toAddress === ZERO_ADDRESS) {
      // do nothing… burn
    } else {
      setTimeout(() => {
        searchForToken(
          String(value),
          fromAddress.toString(),
          toAddress.toString(),
          channel,
          0,
          gasPrice,
          gasUsed
        );
      }, 5000);
    }
  });

  contract.on(
    'TransferSingle',
    async (operator, fromAddress, toAddress, value) => {
      console.log(`Token ${value} Transferrred`);
      setTimeout(() => {
        searchForToken(
          String(value),
          fromAddress.toString(),
          toAddress.toString(),
          channel
        );
      }, 5000);
    }
  );
  contract.on(
    'TransferBatch',
    async (operator, fromAddress, toAddress, values) => {
      setTimeout(() => {
        values.forEach((value) => {
          console.log(`Token ${value} Transferrred`);
          searchForToken(String(value), fromAddress, toAddress, channel);
        });
      }, 5000);
    }
  );
}

async function pollListings(skipFirstTime) {
  const params = new URLSearchParams({
    event_type: 'order',
  });
  const openSeaResponseObject = await axios
    .get(
      `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}?` +
        params,
      fetchOptions
    )
    .catch((e) => {
      console.log('ERROR Fetching Listing Events');
      console.log(e);
    });

  if (openSeaResponseObject && openSeaResponseObject.data) {
    const openSeaResponse = openSeaResponseObject.data;
    if (!openSeaResponse.asset_events) {
      console.log('no asset_events');
    }
    if (openSeaResponse.asset_events) {
      for (let i = 0; i < openSeaResponse.asset_events.length; i += 1) {
        const event = openSeaResponse.asset_events[i];
        if (event.order_type !== 'listing') {
          continue;
        }
        const REF = `listing/${event.order_hash}`;
        const completed = await redisClient.get(REF);
        if (completed) {
          continue;
        }
        if (!completed) {
          await redisClient.set(REF, true);
          if (!skipFirstTime) {
            const name = (event && event.asset && event.asset.name) || '?';
            let image = event.asset.image_url;

            if (
              event.maker.toLowerCase() ===
              '0x750198134f72db6a068423a0e1fb20e5a9c8b26c'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x28fcc58649bb1b85e75eed9f710e11e8e861486c'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x556272591d28705AFA610fb6c82D299379fc162B'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x7b1414a97471bcc28259827bc7db427d3a65cdff'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x9F515f3B8EFb88FBFB24D4bBe624abFF7ba7e7ce'.toLowerCase()
            ) {
              continue;
              // image = 'https://0x420.mypinata.cloud/ipfs/QmVjXXaFxW87R6Fe5Pwdwrr5CkDTtkBvaj6FM5qmKcMyGG';
            }
            if (
              event.maker.toLowerCase() ===
              '0xF30feE0b988AA124F03cc25B8B0e88B2C8667c00'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x90aa587b339e81fa93af9920e78b72d398c8c655'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0xbD40D4fF0b6B1fD591da0138d428B15b2ab343fD'.toLowerCase()
            ) {
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x2ff895e051f7A1c29c2D3bdAB35C4960E3E1ec72'.toLowerCase()
            ) {
              // gemma addition 4/12/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0xF179b80C4699C7e2B97daa8aB20a91c9e952a98C'.toLowerCase()
            ) {
              // gemma addition 4/27/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0xeec9a835df1298587348b5c01048aac2277f340a'.toLowerCase()
            ) {
              // KRILLER addition 6/15/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x622a5b6c4e544a4c085745c4b147d995bb235bbe'.toLowerCase()
            ) {
              // KRILLER addition 6/15/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0xF5e2C95ffa3845c6B8398404FFAdABD2D1b6Eff5'.toLowerCase()
            ) {
              // CYBER BANDIT addition 8/30/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x881ba48b3e959c30a714ebc307e20048aee2aa8f'.toLowerCase()
            ) {
              // CYBER BANDIT addition 9/5/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0xbea8017ccf98017c698a10065d01fdc480930366'.toLowerCase()
            ) {
              // GEMMA addition 9/11/23
              continue;
            }
            if (
              event.maker.toLowerCase() ===
              '0x8328af4c65ace04382f83ab0063884f0ee694d0b'.toLowerCase()
            ) {
              // GEMMA addition 9/25/23
              continue;
            }

            let symbol = event.payment.symbol;
            if (symbol === 'ETH') {
              symbol = ethers.constants.EtherSymbol;
            }

            // let royalty = sale.dev_seller_fee_basis_points / 100;
            // const royaltyField = {
            //   name: 'Royalty to the Artist',
            //   value: `${royalty}%`,
            //   inline: true,
            // };
            const embed = new MessageEmbed()
              .setColor('#0099ff')
              .setTitle(name + '  Listed!')
              .setURL(osLink(event.chain, event.asset))
              .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
              .setThumbnail(event.asset.image_url)
              .addFields(
                {
                  name: 'Price',
                  value: `${ethers.utils.formatEther(BigInt(
                    event.payment.quantity || 0
                  ))}${symbol}`,
                  inline: true,
                },
                {
                  name: 'Seller',
                  value: `${await getOpenSeaName(event.maker)}`,
                  inline: true,
                },
                {
                  name: 'Seller Holds',
                  value: `${(
                    await getBalance(event.maker, event.asset.identifier)
                  ).toLocaleString()}`,
                  inline: true,
                }
              )
              .setImage(image)
              .setTimestamp(new Date(event.start_date * 1000))
              .setFooter(
                'Listed on OpenSea (v2)',
                'https://files.readme.io/566c72b-opensea-logomark-full-colored.png'
              );

            listingChannel.send({ embeds: [embed] });
          }
        }
      }
    }
  }
  setTimeout(pollListings, 10000);
  // setTimeout(keepAlive, 10000);
}

console.log('logging in discord client');
client.login(DISCORD_TOKEN);


