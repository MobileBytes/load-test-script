'use strict';
const fs = require('fs');
const yargs = require('yargs');
const request = require('request');

request.defaults({
	maxSockets: 20
});

const args = yargs
	.options({
		urlHost: {
			alias: 'h',
			demandOption: true,
			describe: 'The url host you are trying to use'
		}
	})
	.help().argv;

/** Args:
 * urlHost (required): the url host that you want to load test
 * prefix (optional): string to filter the url paths by (prefix only)
 * maxPings (optional): limit the number of pings that occur
 */

const urlHost = args.urlHost;
const httpMethod = args.httpMethod ? args.httpMethod.toUpperCase() : null;
const protocolType =
	['wss', 'h2', 'http', 'https'].indexOf(args.protcol) > -1 ? args.protcol : null;
const pathPrefix = args.prefix || null;
const maxPings = args.maxPings || null;
const runByTxTimes = args.useTxTime ? args.useTxTime != 'false' : true;

console.log(runByTxTimes);

// taken from the Access Log Entries Syntax table of https://docs.aws.amazon.com/elasticloadbalancing/latest/application//load-balancer-access-logs.html
//    ...with a few noted additions
const cloudwatchMap = [
	'type',
	'timestamp',
	'elb',
	'client: port',
	'target: port',
	'request_processing_time',
	'target_processing_time',
	'response_processing_time',
	'elb_status_code',
	'target_status_code',
	'received_bytes',
	'sent_bytes', // The three below were broken out from a single line called `request`
	'http_method', // 0
	'request', // 1
	'http_version', // 2
	'user_agent',
	'ssl_cipher',
	'ssl_protocol',
	'target_group_arn',
	'trace_id',
	'domain_name',
	'chosen_cert_arn',
	'matched_rule_priority',
	'request_creation_time',
	'actions_executed',
	'redirect_url',
	'error_reason',
	'target: port_list',
	'target_status_code_list'
];

/** Read in a file and save it to an array of DTOs */
const convertFileToArrayOfData = file => {
	console.log(`Reading ./data/${file}`);
	const fileContents = fs.readFileSync(`./data/${file}`, { encoding: 'utf8' });

	let rows = fileContents.split('\n');
	for (let i = 0; i < rows.length; i++) {
		const container = {};
		const regexpGroups = /([A-z0-9-:.\/]+)|"([A-z0-9-:.\/=]+\s*)"/gm;

		try {
			var match = regexpGroups.exec(rows[i]);
			let matchIndex = 0;
			do {
				// Although the do while checks null, it isn't working...
				if (!match) {
					continue;
				}

				const matchText = match[1] || match[2];
				const cloudWatchMapIndex = cloudwatchMap[matchIndex];

				if (protocolType && cloudWatchMapIndex == 'type') {
					if (matchText != protocolType) {
						break;
					}
				}
				container[cloudWatchMapIndex] = matchText;
				if (cloudWatchMapIndex == 'request') {
					container.path_prefix = matchText.split(/:[0-9]+/)[1];
				}
				matchIndex++;
			} while ((match = regexpGroups.exec(rows[i])) !== null);
		} catch (err) {
			console.error(err, match);
		}

		rows[i] = container;
	}

	console.log(`filtering ${rows.length} rows`);
	if (pathPrefix || httpMethod) {
		rows = rows.filter(row => {
			return (
				(!pathPrefix ||
					(row.path_prefix ? row.path_prefix.startsWith(pathPrefix) : false)) &&
				(!httpMethod || row.http_method == httpMethod)
			);
		});
	}
	console.log(`filtered to ${rows.length} rows`);

	return rows;
};

/** Ping all the urls with the correct timeouts */
console.time('totalPingTime');
const initialDate = new Date();
const pingUrls = rows => {
	if (maxPings) {
		rows = rows.slice(0, maxPings);
	}

	let i = 0;
	const numTimes = rows.length - 1;
	const doTheThing = () => {
		const timeBeforeNextPing =
			new Date(rows[i + 1].timestamp).getTime() - new Date(rows[i].timestamp).getTime();
		ping(rows[i].path_prefix, rows[i].timestamp, numTimes);

		i++;
		if (i < numTimes) {
			if (runByTxTimes) {
				if (timeBeforeNextPing > 0) {
					const durationSec = (new Date() - initialDate) / 1000;
					const reqPerSec = Math.round((i / durationSec) * 100) / 100;
					console.log(
						`timeout for ${timeBeforeNextPing}ms after ${i} requests in ${durationSec} seconds for ${reqPerSec} req/sec`
					);
				}
				setTimeout(doTheThing, timeBeforeNextPing);
			} else {
				setTimeout(doTheThing, 1000);
			}
		} else {
			const totalPingTime = console.timeEnd('totalPingTime');
			const totalDurationSec = (new Date() - initialDate) / 1000;
			const totalReqPerSec = Math.round((i / totalDurationSec) * 100) / 100;
			console.log(
				`submit complete for ${numTimes} requests in time ${totalPingTime}ms`,
				` for ${totalReqPerSec} req/sec`,
				'summary stats of request counts by statusCode:',
				statusCodeCounts
			);
		}
	};

	doTheThing();
};

/** The ping function */
let statusCodeCounts = {};
let responseCount = 0;
console.time('totalResponseTime');
const ping = (urlStem, time, totalRunCount) => {
	// Still need to break out the method and fake some POST body data
	request(`${urlHost}${urlStem}`, { time: true }, (err, res, body) => {
		if (err) {
			return console.log(err);
		}
		responseCount++;
		console.log(
			res.statusCode === 200
				? '\x1b[32m%s\x1b[0m'
				: res.statusCode === 404
				? '\x1b[33m%s\x1b[0m'
				: '\x1b[31m%s\x1b[0m',
			`${time}: Took ${res.elapsedTime}ms; ${urlHost}${urlStem} returned ${res.statusCode}. Count: ${responseCount}`
		);
		if (!statusCodeCounts[res.statusCode]) {
			statusCodeCounts[res.statusCode] = 0;
		}
		statusCodeCounts[res.statusCode]++;

		const reportingIntervalCount = Math.round(totalRunCount / 100);
		if (responseCount % reportingIntervalCount === 0) {
			const totalDurationSec = (new Date() - initialDate) / 1000;
			const totalReqPerSec = Math.round((responseCount / totalDurationSec) * 100) / 100;
			console.log(
				`ping response status: `,
				`Count: ${responseCount} Duration: ${totalDurationSec} Response Req/sec: ${totalReqPerSec}`
			);
		}
	});
};

/** Read all files */
const runLoadTest = () => {
	if (typeof urlHost == 'undefined') {
		return '-';
	}
	fs.readdir('./data', function(err, files) {
		if (err) {
			console.error('Could not list the directory.', err);
			process.exit(1);
		}

		var allFilesData = [];

		files.forEach(file => {
			allFilesData.push(...convertFileToArrayOfData(file));
		});

		console.log(`Sorting ${allFilesData.length} rows by timestamp`);

		allFilesData = allFilesData
			.filter(d => typeof d.timestamp !== 'undefined' && d.timestamp !== null)
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

		if (!allFilesData.length) {
			console.log('No data');
			return;
		}

		pingUrls(allFilesData);
	});
};

runLoadTest();
