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
  OPENSEA_KEY,
  COLLECTION_SLUG,
  ENS_PROVIDER_URL,
  AUTHOR_NAME,
  AUTHOR_THUMBNAIL,
  AUTHOR_URL,
  LISTING_CHANNEL_ID,
  BURB_CAGE_ADDRESS,
  BURB_CAGE_CHANNEL_ID
 } = process.env;

const MINT_ADDRESS = '0x0000000000000000000000000000000000000000';
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
  listenForSales(channel, mintChannel);
  if (BURB_CAGE_CHANNEL_ID) {
    burbCageChannel = await client.channels.fetch(BURB_CAGE_CHANNEL_ID);
  }
  if (LISTING_CHANNEL_ID) {
    listingChannel = await client.channels.fetch(LISTING_CHANNEL_ID);
    redisClient = new Redis(redis_url, redisOptions);
    pollListings(true);
  }
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

async function getBalance(acct) {
  if (!acct) {
    return '?';
  }
  const address = acct.address;
  return await contract.balanceOf(address).catch(() => 0);
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
      value: `${await getOpenSeaName(from)}`,
      inline: true,
    },
    {
      name: 'BurbCage Holds',
      value: `${(await getBalance({ address: BURB_CAGE_ADDRESS })).toLocaleString()}`,
      inline: true,
    },
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

async function mint(toAddress, value, channel, count) {
  count = count || 0;
  const tokenURI = await contract.tokenURI(value);
  const totalSupply = (await contract.totalSupply()).toNumber();
  // todo: make this work for JSON tokenURI's
  const response = await axios
    .get(tokenURI.replace('ipfs://', 'https://0x420.mypinata.cloud/ipfs/'))
    .catch(() => false);
  if (!response) {
    console.log('Error fetching token metadata');
    if (count < 3) {
      setTimeout(() => {
        mint(toAddress, value, channel, count + 1);
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
      name: 'Minter',
      value: `${await getOpenSeaName(toAddress)}`,
      inline: true,
    },
    {
      name: 'Minter Holds',
      value: `${(await getBalance({ address: toAddress })).toLocaleString()}`,
      inline: true,
    },
    { name: 'Total Supply', value: totalSupply.toLocaleString(), inline: true },
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
    .setTitle(token.name + ' minted!')
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(AUTHOR_THUMBNAIL)
    .addFields(fields)
    .setImage(image)
    .setTimestamp();
  channel.send({ embeds: [embed] });
}
const buildMessage = async (sale) =>
  new MessageEmbed()
    .setColor('#0099ff')
    .setTitle(sale.asset.name + ' sold!')
    .setURL(sale.asset.permalink)
    .setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
    .setThumbnail(sale.asset.collection.image_url)
    .addFields(
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
        value: `${(await getBalance(sale.winner_account)).toLocaleString()}`,
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
        value: `${(await getBalance(sale.seller)).toLocaleString()}`,
        inline: true,
      }
    )
    .setImage(sale.asset.image_url)
    .setTimestamp(Date.parse(`${sale.created_date}Z`))
    .setFooter(
      'Sold on OpenSea',
      'https://files.readme.io/566c72b-opensea-logomark-full-colored.png'
    );

async function searchForToken(token, from, to, channel, count) {
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
        const embed = await buildMessage(found);
        channel.send({ embeds: [embed] });
      }
    }
  }
  if (!found && count < 30) {
    setTimeout(() => {
      searchForToken(token, from, to, channel, count + 1);
    }, count * count * 1000);
  }
}

function listenForSales(channel, mintChannel) {
  if (BURB_CAGE_ADDRESS) {
    cageContract.on('BurbCaged', async (fromAddress, tokenId) => {
      console.log(
        `Burb Caged! ${tokenId} caged by ${fromAddress}`
      );
      caged(fromAddress, tokenId);
    });
  }

  contract.on('Transfer', async (fromAddress, toAddress, value) => {
    console.log(
      `Token ${value} Transferred from ${fromAddress} to ${toAddress}`
    );
    if (fromAddress === MINT_ADDRESS) {
      mint(toAddress, value, mintChannel);
    } else {
      setTimeout(() => {
        searchForToken(
          String(value),
          fromAddress.toString(),
          toAddress.toString(),
          channel
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
        const completed = await redisClient.get(`listing:${sale.id}`);
        if (!completed) {
          await redisClient.set(`listing:${sale.id}`, true);
          if (!skipFirstTime) {
            const embed = new MessageEmbed()
              .setColor('#0099ff')
              .setTitle(sale.asset.name + '  Listed!')
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
                  value: `${(await getBalance(sale.seller)).toLocaleString()}`,
                  inline: true,
                }
              )
              .setImage(sale.asset.image_url)
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
}

client.login(DISCORD_TOKEN);
