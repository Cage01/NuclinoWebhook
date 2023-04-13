const functions = require("firebase-functions");
const fetch = require('node-fetch');
const fs = require('fs');
require('dotenv').config();

var discovered_items = new Map();
const watch_window = 45;

//Subtracks the input from the current time to get how long ago something occurred in minutes
function minutesAgo(input) {
    const date = (input instanceof Date) ? input : new Date(input);
    const secondsElapsed = (date.getTime() - Date.now()) / 1000;

    const delta = secondsElapsed / 60;
    return Math.abs(Math.round(delta));
}

//Combines any iteralbles into a single set
function concatSets(set, ...iterables) {
    for (const iterable of iterables) {
        for (const item of iterable) {
            set.add(item);
        }
    }
}

//Builds the API endpoint url
function getURL(endpoint) {
    return process.env.API_BASE_URL + process.env.API_VERSION + endpoint;
}

//Getter function for handling headers. This only contains the API_KEY for nuclino currently, and is located in the .env file
function getHeaders() {
    return {
        Authorization: process.env.API_KEY
    }
}

async function fetchWorkspace() {
    const url = new URL(getURL("workspaces"));
    const res = await fetch(url, {
        method: 'GET',
        headers: getHeaders(),
    });

    const json = await res.json();

    return json.data.results[0];
}

async function fetchUser(ID) {
    const url = new URL(getURL("users/" + ID));

    const res = await fetch(url, {
        method: 'GET',
        headers: getHeaders()
    });
    const json = await res.json();

    return json.data;
}

async function fetchItemsFromWorkspace(ID, afterUUID) {
    const url = new URL(getURL("items"));
    url.searchParams.set("workspaceId", ID);

    //Handles pagination
    if (afterUUID != null)
        url.searchParams.set("after", afterUUID);

    const res = await fetch(url, {
        method: 'GET',
        headers: getHeaders()
    });
    const json = await res.json();

    return json.data.results;
}

async function fetchItem(ID) {
    const url = new URL(getURL("items/" + ID));

    const res = await fetch(url, {
        method: 'GET',
        headers: getHeaders()
    });
    const json = await res.json();

    //add to global variable for quick lookup
    discovered_items.set(json.data.id, json.data)

    return json.data;
}

//Traverse the page tree
async function searchCollection(setIDs) {

    var curr = new Set();
    for (id of setIDs) {

        let item = await fetchItem(id);
        if (item.object == "collection" && item.childIds != null && item.childIds.length > 0) {
            concatSets(curr, item.childIds);

            var sub = await searchCollection(curr);

            if (sub != null && typeof sub !== 'undefined')
                concatSets(curr, sub);
        }
    }

    concatSets(setIDs, curr);
    return setIDs;
}

function buildNotification(infoString, authorName, iconURL, workspaceTitle, workspaceURL, fieldArr) {
    return {
        embeds: [{
            author: {
                name: authorName,
                icon_url: iconURL
            },
            title: workspaceTitle,
            url: workspaceURL,
            description: infoString,
            color: 10554661,
            fields: fieldArr
        }],

    }
}

function buildField(changeType, name, pageURL, contentSubstring) {
    return {
        name: name + " " + changeType,
        value: contentSubstring + "...\n**[\[read more\]](" + pageURL + ")**"
    }
}

function notify(body) {
    fetch(process.env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then((resp) => {
            if (resp.ok) {
                console.log('Sent notification')
            } else {
                console.error(resp);
            }
        })
}

exports.watcher = functions.pubsub.schedule("every " + watch_window + " minutes").onRun(async () => {
    //Will return the first ID that it finds, this works for now
    const workspace = await fetchWorkspace();


    //try to get all items
    var items = await fetchItemsFromWorkspace(workspace.id, null);
    var working = true;
    while (working) {
        if (items.length >= 100) {
            let lastID = items[items.length - 1].id;
            const page = await fetchItemsFromWorkspace(workspace.id, lastID);

            if (page.length > 0)
                items.concat(page);
            else
                working = false;
        } else {
            working = false;
        }

    }

    var childItems = []; //Will build this list while searching through items
    const userMap = new Map();


    for (const item of items) {
        var recentlyCreated = false;

        //contains child items
        if (item.object == "collection") {
            childItems = childItems.concat(item);
        }

        //created within the last x minutes
        if (minutesAgo(item.createdAt) <= watch_window) {
            recentlyCreated = true;

            const userID = item.createdUserId;
            if (userMap.has(userID)) {
                userMap.get(userID).created.add(item.id)
            } else {
                userMap.set(userID, { created: new Set([item.id]), updated: new Set() })
            }
        }

        //updated within the last x minutes
        if (minutesAgo(item.lastUpdatedAt) <= watch_window && !recentlyCreated) {
            const userID = item.lastUpdatedUserId;
            if (userMap.has(userID)) {
                userMap.get(userID).updated.add(item.id)
            } else {
                userMap.set(userID, { updated: new Set([item.id]), created: new Set() });
            }
        }
    }

    // Loop through all child items, doing the same work as above
    var childItemIDs = new Set();
    for (const item of childItems) {
        concatSets(childItemIDs, await searchCollection(new Set(item.childIds)));
    }

    for (itemID of childItemIDs) {
        const item = await fetchItem(itemID);

        //created within the last x minutes
        if (minutesAgo(item.createdAt) <= watch_window) {
            recentlyCreated = true;

            const userID = item.createdUserId;
            if (userMap.has(userID)) {
                userMap.get(userID).created.add(item.id)
            } else {
                userMap.set(userID, { created: new Set([item.id]), updated: new Set() })
            }
        }

        //updated within the last x minutes
        if (minutesAgo(item.lastUpdatedAt) <= watch_window && !recentlyCreated) {
            const userID = item.lastUpdatedUserId;
            if (userMap.has(userID)) {
                userMap.get(userID).updated.add(item.id)
            } else {
                userMap.set(userID, { updated: new Set([item.id]), created: new Set() });
            }
        }
    }

    //Extract info from mapped items to then notify the webhook
    if (userMap.size > 0) {
        fields = []
        for (const [userID, typeSet] of userMap.entries()) {
            const user = await fetchUser(userID);
            //Short snippet of the content on that page up to 150 characters.
            const infoString = (typeof item.content != 'undefined') ? item.content.substring(0, 150).replaceAll('\n', '') + "..." : "";

            if (typeof typeSet.created !== 'undefined') {
                for (itemID of typeSet.created) {
                    var item = null;

                    if (discovered_items.has(itemID))
                        item = discovered_items.get(itemID)
                    else
                        item = await fetchItem(itemID);

                    //This field will provide the name of the page or item modified, along with a [read more] url to the page, a snippet and the modify type
                    if (item != null)
                        fields.push(buildField("(Created)", item.title, item.url, infoString));

                }
            }

            if (typeof typeSet.updated !== 'undefined') {
                for (itemID of typeSet.updated) {
                    var item = null;

                    if (discovered_items.has(itemID))
                        item = discovered_items.get(itemID)
                    else
                        item = await fetchItem(itemID);

                    //This field will provide the name of the page or item modified, along with a [read more] url to the page, a snippet and the modify type
                    if (item != null)
                        fields.push(buildField("(Updated)", item.title, item.url, infoString));
                }
            }

            //Provides a link for the Discord embed to be clicked on to take you to the workspace
            const workspaceURL = process.env.TEAM_URL + workspace.name.replaceAll(' ', '-');

            //Builds a description of how many pages were created/updated within the watch window
            var createdDesc = "";
            if (typeof typeSet.created !== 'undefined' && typeSet.created.size > 0) {
                createdDesc = typeSet.created.size + (typeSet.created.size > 1 ? " pages" : " page") + " created";
            }
            var updatedDesc = "";
            if (typeof typeSet.updated !== 'undefined' && typeSet.updated.size > 0) {
                updatedDesc = typeSet.updated.size + (typeSet.updated.size > 1 ? " pages" : " page") + " updated";
            }
            const desc = (createdDesc.length > 0 ? createdDesc + (updatedDesc.length > 0 ? " - " : "") + updatedDesc: updatedDesc)

            //Creating the
            const notif = buildNotification(desc, user.firstName, user.avatarUrl, workspace.name, workspaceURL, fields);
            console.log("Sending: \n" + JSON.stringify(notif))
            notify(notif);
            console.log("Notification sent");
        }
    } else {
        console.log("No updates to notify");
    }
});
