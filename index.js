const axios = require('axios');
const ethers = require('ethers');
const { Client, Intents, MessageEmbed } = require('discord.js');
const ABI = require('./abi');
if (process.env.ENVIRONMENT !== 'production') {
	require('dotenv').config();
}

const {
	DISCORD_TOKEN,
	CHANNEL_ID,
	OPENSEA_KEY,
	COLLECTION_SLUG,
	ENS_PROVIDER_URL,
	AUTHOR_NAME,
	AUTHOR_THUMBNAIL,
	AUTHOR_URL,
} = process.env;
const fetchOptions = {
	headers: { 'x-api-key': OPENSEA_KEY },
};
const ensprovider = new ethers.providers.JsonRpcProvider(ENS_PROVIDER_URL);
const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider);
provider.pollingInterval = 30000;

// Create a new client instance
const client = new Client({ intents: [Intents.FLAGS.GUILDS] });

// When the client is ready, run this code (only once)
client.once('ready', async () => {
	console.log('Ready!');
	console.log(`Watching ${await contract.name()}`);
	const channel = await client.channels.fetch(CHANNEL_ID);
	listenForSales(channel);
});

async function getOpenSeaName(address) {
	const response = await axios.get(`https://api.opensea.io/api/v1/user/${address}`, fetchOptions)
		.catch(() => ({ data:{} }));
	let username = response.data.username;
	if (!username) {
		username = await getENSName(address);
	}
	else {
		username = `[${username}](https://opensea.io/${username})`;
	}
	return username;
}
async function getENSName(address) {
	let name = await ensprovider.lookupAddress(address).catch(() => (false));
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
	return await contract.balanceOf(address).catch(() => (0));
}

const buildMessage = async (sale) => (
	new MessageEmbed()
		.setColor('#0099ff')
		.setTitle(sale.asset.name + ' sold!')
		.setURL(sale.asset.permalink)
		.setAuthor(AUTHOR_NAME, AUTHOR_THUMBNAIL, AUTHOR_URL)
		.setThumbnail(sale.asset.collection.image_url)
		.addFields(
			{ name: 'Price', value: `${ethers.utils.formatEther(sale.total_price || '0')}${ethers.constants.EtherSymbol}`, inline: true },
			{ name: 'Times Sold', value: sale.asset.num_sales.toLocaleString(), inline: true },
			{ name: '\u200B', value: '\u200B', inline: true },
			{ name: 'Buyer', value: `${await getOpenSeaName(sale.winner_account.address)}`, inline: true },
			{ name: 'Buyer Holds', value: `${(await getBalance(sale.winner_account)).toLocaleString()}`, inline: true },
			{ name: '\u200B', value: '\u200B', inline: true },
			{ name: 'Seller', value: `${await getOpenSeaName(sale.seller.address)}`, inline: true },
			{ name: 'Seller Holds', value: `${(await getBalance(sale.seller)).toLocaleString()}`, inline: true },
		)
		.setImage(sale.asset.image_url)
		.setTimestamp(Date.parse(`${sale.created_date}Z`))
		.setFooter('Sold on OpenSea', 'https://files.readme.io/566c72b-opensea-logomark-full-colored.png')
);

async function searchForToken(token, channel, count) {
	console.log(`Searching for token ${token} attempt ${count}`);
	count = count || 0;
	let found = false;
	const params = new URLSearchParams({
		collection_slug: COLLECTION_SLUG,
		event_type: 'successful',
		only_opensea: 'false',
		offset: '0',
		limit: '50',
		occurred_after: Math.floor(((new Date().getTime()) / 1000) - 60 * ((count + 1) * 2)),
	});
	console.log('With params:', params);


	const openSeaResponseObject = await axios.get('https://api.opensea.io/api/v1/events?' + params, fetchOptions)
		.catch((e) => {
			console.log('ERRRRR');
			console.log(e);
		});
	const openSeaResponse = openSeaResponseObject.data;
	if (!openSeaResponse.asset_events) {
		console.log('no asset_events');
	}
	if (openSeaResponse.asset_events) {
		openSeaResponse.asset_events.forEach((event) => {
			console.log(`Comparing ${token} to ${event.asset.token_id}`);
			if (event.asset.token_id === token) {
				found = event;
			}
		});
		if (found && found.winner_account) {
			const embed = await buildMessage(found);
			channel.send({ embeds: [embed] });
		}
	}
	if (!found && count < 30) {
		setTimeout(() => {
			searchForToken(token, channel, count + 1);
		}, count * 2000);
	}
}

function listenForSales(channel) {
	contract.on('Transfer', async (fromAddress, toAddress, value) => {
		console.log(`Token ${value} Transferrred`);
		setTimeout(() => {
			searchForToken(String(value), channel);
		}, 5000);
	});

	contract.on('TransferSingle', async (operator, fromAddress, toAddress, value) => {
		console.log(`Token ${value} Transferrred`);
		setTimeout(() => {
			searchForToken(String(value), channel);
		}, 5000);
	});
	contract.on('TransferBatch', async (operator, fromAddress, toAddress, values) => {
		setTimeout(() => {
			values.forEach((value) => {
				console.log(`Token ${value} Transferrred`);
				searchForToken(String(value), channel);
			});
		}, 5000);
	});
}


client.login(DISCORD_TOKEN);
