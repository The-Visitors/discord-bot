const ethers = require('ethers');
const axios = require('axios');
const { Client, Intents, MessageEmbed } = require('discord.js');
const ABI = require('./abi');
const CAGE_ABI = require('./burbcageabi');

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
  BURN_CHANNEL_ID,
  OPENSEA_KEY,
  COLLECTION_SLUG,
  ENS_PROVIDER_URL,
  AUTHOR_NAME,
  AUTHOR_THUMBNAIL,
  AUTHOR_URL,
  LISTING_CHANNEL_ID,
  BURB_CAGE_ADDRESS,
  BURB_CAGE_CHANNEL_ID,
} = process.env;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const fetchOptions = {
  headers: { 'x-api-key': OPENSEA_KEY },
};
const ensprovider = new ethers.providers.JsonRpcProvider(ENS_PROVIDER_URL);
const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL);
let cageContract;
if (BURB_CAGE_ADDRESS) {
  cageContract = new ethers.Contract(
    process.env.BURB_CAGE_ADDRESS,
    CAGE_ABI,
    provider
  );
}
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
let burbCageChannel;

// When the client is ready, run this code (only once)
client.once('ready', async () => {
  console.log('Ready!');
  console.log(`Watching ${await contract.name()}`);
  const channel = await client.channels.fetch(CHANNEL_ID);
  const mintChannel = MINT_CHANNEL_ID
    ? await client.channels.fetch(MINT_CHANNEL_ID)
    : channel;
  const burnChannel = BURN_CHANNEL_ID
    ? await client.channels.fetch(BURN_CHANNEL_ID)
    : false;
  listenForSales(channel, mintChannel, burnChannel);
  if (BURB_CAGE_CHANNEL_ID) {
    burbCageChannel = await client.channels.fetch(BURB_CAGE_CHANNEL_ID);
  }
  if (LISTING_CHANNEL_ID) {
    listingChannel = await client.channels.fetch(LISTING_CHANNEL_ID);
    redisClient = new Redis(redis_url, redisOptions);
    pollListings(true);
  }
});

client.on('error', function (error) {
  console.error(`client's WebSocket encountered a connection error: ${error}`);
});

async function getOpenSeaName(address) {
  const response = await axios
    .get(`https://api.opensea.io/api/v1/user/${address}`, fetchOptions)
    .catch(() => false);
  let username;
  if (
    !response ||
    !response.data ||
    response.data.username === 'null' ||
    response.data.username === null
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

async function getBalance(acct, id) {
  if (!acct) {
    return '?';
  }
  const address = acct.address;
  let balance;
  try {
    balance = await contract.balanceOf(address);
  } catch (_) {
    try {
      balance = await contract.balanceOf(address, id);
    } catch (_) {}
  }
  return balance || 0;
}

async function caged(from, value, count) {
  count = count || 0;
  const tokenURI = await contract.tokenURI(value);
  // todo: make this work for JSON tokenURI's
  const response = await axios
    .get(tokenURI.replace('ipfs://', 'https://0x420.mypinata.cloud/ipfs/'))
    .catch(() => false);
  if (!response) {
    console.log('Error fetching token metadata');
    if (count < 3) {
      setTimeout(() => {
        caged(from, value, count + 1);
      }, 1000);
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
      name: 'Cager',
      value: `${await getENSName(from)}`,
      inline: true,
    },
    {
      name: 'BurbCage Holds',
      value: `${(
        await getBalance(BURB_CAGE_ADDRESS)
      ).toLocaleString()}`,
      inline: true,
    },
    { name: '\u200B', value: '\u200B', inline: true },
  ];
  token.attributes.forEach((attr) => {
    fields.push({
      name: attr.trait_type,
      value: attr.value,
      inline: true,
    });
  });
  const embed = new MessageEmbed()
    .setColor('#0099ff')
    .setTitle(token.name + ' Caged!')
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(AUTHOR_THUMBNAIL)
    .addFields(fields)
    .setImage(image)
    .setTimestamp();
  burbCageChannel.send({ embeds: [embed] });
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

  if (gasPrice && gasUsed) {
    fields.push({
      name: 'Gas Price',
      value: `${gasPrice} Gwei`,
      inline: true,
    });
    fields.push({
      name: 'Gas Spent',
      value: `${gasUsed} Ether`,
      inline: true,
    });
  }
  const embed = new MessageEmbed()
    .setColor('#0099ff')
    .setURL(
      `https://opensea.io/assets/${process.env.CONTRACT_ADDRESS}/${tokenId}`
    ) // todo this needs to handle /matic/
    .setTitle(token.name + ' minted!')
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(AUTHOR_THUMBNAIL)
    .addFields(fields)
    .setImage(image)
    .setTimestamp();
  channel.send({ embeds: [embed] });
}
async function burn(fromAddress, value, channel, count, gasPrice, gasUsed) {
  count = count || 0;
  const tokenURI = `https://gemma.art/api/nft/${value}`;
  const totalSupply = (await contract.totalSupply()).toNumber();
  // todo: make this work for JSON tokenURI's
  const response = await axios
    .get(tokenURI.replace('ipfs://', 'https://0x420.mypinata.cloud/ipfs/'))
    .catch(() => false);
  if (!response) {
    console.log('Error fetching token metadata');
    if (count < 3) {
      setTimeout(() => {
        burn(fromAddress, value, channel, count + 1);
      }, 1000);
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
      name: 'Burner',
      value: `${await getOpenSeaName(fromAddress)}`,
      inline: true,
    },
    {
      name: 'Burner Holds',
      value: `${(await getBalance(fromAddress, value)).toLocaleString()}`,
      inline: true,
    },
    { name: 'Total Supply', value: totalSupply.toLocaleString(), inline: true },
  ];

  if (gasPrice && gasUsed) {
    fields.push({
      name: 'Gas Price',
      value: `${gasPrice} Gwei`,
      inline: true,
    });
    fields.push({
      name: 'Gas Spent',
      value: `${gasUsed} Ether`,
      inline: true,
    });
  }
  if (token.attributes) {
    token.attributes.forEach((attr) => {
      fields.push({
        name: attr.trait_type,
        value: attr.value,
        inline: true,
      });
    });
  }
  const embed = new MessageEmbed()
    .setColor('#FF0000')
    .setTitle(token.name + ' burned!')
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
      name: 'Price',
      value: `${ethers.utils.formatEther(sale.total_price || '0')}${
        ethers.constants.EtherSymbol
      }`,
      inline: true,
    },
    {
      name: 'Times Sold',
      value: sale.asset.num_sales.toLocaleString(),
      inline: true,
    },
    { name: '\u200B', value: '\u200B', inline: true },
    {
      name: 'Buyer',
      value: `${await getOpenSeaName(sale.winner_account.address)}`,
      inline: true,
    },
    {
      name: 'Buyer Holds',
      value: `${(await getBalance(sale.winner_account, sale.asset.token_id)).toLocaleString()}`,
      inline: true,
    },
    { name: '\u200B', value: '\u200B', inline: true },
    {
      name: 'Seller',
      value: `${await getOpenSeaName(sale.seller.address)}`,
      inline: true,
    },
    {
      name: 'Seller Holds',
      value: `${(await getBalance(sale.seller, sale.asset.token_id)).toLocaleString()}`,
      inline: true,
    },
  ];
  if (gasPrice && gasUsed) {
    fields.push({
      name: 'Gas Price',
      value: `${gasPrice} Gwei`,
      inline: true,
    });
    fields.push({
      name: 'Gas Spent',
      value: `${gasUsed} Ether`,
      inline: true,
    });
  }

  return new MessageEmbed()
    .setColor('#0099ff')
    .setTitle(sale.asset.name + ' sold!')
    .setURL(sale.asset.permalink)
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(sale.asset.collection.image_url)
    .addFields(fields)
    .setImage(sale.asset.image_url)
    .setTimestamp(Date.parse(`${sale.created_date}Z`))
    .setFooter(
      'Sold on OpenSea',
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
    collection_slug: COLLECTION_SLUG,
    event_type: 'successful',
  });
  console.log('With params:', params);

  const openSeaResponseObject = await axios
    .get('https://api.opensea.io/api/v1/events?' + params, fetchOptions)
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
        if (event.asset) {
          console.log(
            `Comparing ${token} to ${event.asset.token_id}, to: ${to}, winner: ${event.winner_account.address}`
          );
          if (
            event.asset.token_id === token &&
            to.toLowerCase() === event.winner_account.address.toLowerCase()
          ) {
            found = event;
          }
        } else {
          console.log('Strange event', event);
        }
      });
      if (found && found.winner_account) {
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

function keepAlive() {
  contract.name().then((r) => {
    // console.log(`Keep Alive for ${r}`);
  });
}

function listenForSales(channel, mintChannel, burnChannel) {
  if (BURB_CAGE_ADDRESS) {
    cageContract.on('BurbCaged', async (fromAddress, tokenId) => {
      console.log(`Burb Caged! ${tokenId} caged by ${fromAddress}`);
      caged(fromAddress, tokenId);
    });
  }

  contract.on('Transfer', async (fromAddress, toAddress, value, event) => {
    if (toAddress.toLowerCase() === (BURB_CAGE_ADDRESS || '').toLowerCase()) {
      return;
    }
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
      if (burnChannel) {
        burn(fromAddress, value, burnChannel, 0, gasPrice, gasUsed);
      }
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
    collection_slug: COLLECTION_SLUG,
    event_type: 'created',
  });
  const openSeaResponseObject = await axios
    .get('https://api.opensea.io/api/v1/events?' + params, fetchOptions)
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
        const sale = openSeaResponse.asset_events[i];
        if (
          !sale.id ||
          !sale.asset ||
          !sale.asset.name ||
          !sale.asset.permalink
        ) {
          console.log('weird asset for listing ' + sale.id);
          console.log(sale.asset);
          continue;
        }
        const completed = await redisClient.get(`listing:${sale.id}`);
        if (!completed) {
          await redisClient.set(`listing:${sale.id}`, true);
          if (!skipFirstTime) {
            const name = (sale && sale.asset && sale.asset.name) || '?';
            let image = sale.asset.image_url;
            if (sale.seller.address.toLowerCase() === '0x9F515f3B8EFb88FBFB24D4bBe624abFF7ba7e7ce'.toLowerCase()) {
              continue;
              // image = 'https://0x420.mypinata.cloud/ipfs/QmVjXXaFxW87R6Fe5Pwdwrr5CkDTtkBvaj6FM5qmKcMyGG';
            }
            if (sale.seller.address.toLowerCase() === '0xbA7a5953A02dA87Fabd001a88794A5C33eaFBb14'.toLowerCase()) {
              continue;
            }
            const embed = new MessageEmbed()
              .setColor('#0099ff')
              .setTitle(name + '  Listed!')
              .setURL(sale.asset.permalink)
              .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
              .setThumbnail(sale.asset.collection.image_url)
              .addFields(
                {
                  name: 'Price',
                  value: `${ethers.utils.formatEther(
                    sale.starting_price || '0'
                  )}${ethers.constants.EtherSymbol}`,
                  inline: true,
                },
                {
                  name: 'Times Sold',
                  value: sale.asset.num_sales.toLocaleString(),
                  inline: true,
                },
                { name: '\u200B', value: '\u200B', inline: true },
                {
                  name: 'Seller',
                  value: `${await getOpenSeaName(sale.seller.address)}`,
                  inline: true,
                },
                {
                  name: 'Seller Holds',
                  value: `${(await getBalance(sale.seller, sale.asset.token_id)).toLocaleString()}`,
                  inline: true,
                }
              )
              .setImage(image)
              .setTimestamp(Date.parse(`${sale.created_date}Z`))
              .setFooter(
                'Listed on OpenSea',
                'https://files.readme.io/566c72b-opensea-logomark-full-colored.png'
              );

            listingChannel.send({ embeds: [embed] });
          }
        }
      }
    }
  }
  setTimeout(pollListings, 10000);
  setTimeout(keepAlive, 10000);
}

console.log('logging in discord client');
client.login(DISCORD_TOKEN);
