const _ = require("underscore")         // Used to sort tracks by properties
const fs = require("fs")                // Used to write to token.json
const reader = require('readline-sync') // Used to get user input for url
const open = require("open")            // Used to open auth in browser
const request = require("request")      // Used to get/post/put to Spotify API
const express = require("express")      // Used to listen for auth callback
const sharp = require("sharp")          // Used to resize base64 image for request

const clientID = "0f09a21337fa472c9beb3c309079239e"
const clientSecret = "" // Get from `https://developer.spotify.com/dashboard/applications/${clientId}`
const redirectURI = "http://localhost:8888/callback"
const scopes = encodeURIComponent("playlist-modify-private ugc-image-upload")

const app = express() // Creates express application
app.listen(8888) // Attach app to port 8888

// Handler for callback endpoint (what Spotify redirects to after authentication)
app.get("/callback", function(req, res) {
    const authOptions = {
        form: {
            code: req.query.code,
            redirect_uri: redirectURI,
            grant_type: "authorization_code"
        },
        headers: { "Authorization": `Basic ${new Buffer.from(clientID + ":" + clientSecret).toString("base64")}`},
        url: "https://accounts.spotify.com/api/token",
        json: true
    }
    request.post(authOptions, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            const token = body.access_token
            fs.writeFileSync("./token.json", token, function(error) { if (error) { onError(error) }})
            res.send("Access granted. You can close this tab and return to the application.")
            console.log("Access granted.")
            onStart()
        } else if (response.body.error === "invalid_client") { 
            open(`https://developer.spotify.com/dashboard/applications/${clientID}`)
            res.send("Error code " + response.statusCode + ": " + response.body.error)
            onError("Invalid Client Secret. Paste the Client Secret into clientSecret in main.js, then run main.js again. Exiting application now.")
        } else {
            res.send(error || response.body.error)
            onError(error || response.body.error)
        }
    })
})

async function verifySecret() {
    if (clientSecret === null || clientSecret === "") {
        await open(`https://developer.spotify.com/dashboard/applications/${clientID}`)
        onError("Invalid Client Secret. Paste the Client Secret into clientSecret in main.js, then run main.js again. Exiting application now.")
    }
}

async function login(reason) {
    await verifySecret()
    if (reason === "initial") { console.log("Please allow access to your Spotify account in your browser before continuing.") } 
    else if (reason === "expired") { console.log("Login expired. Please log to Spotify again.") } 
    else { onError("Error: Invalid login reason") } 
    open(`https://accounts.spotify.com/authorize?response_type=code&client_id=${clientID}&scope=${scopes}&redirect_uri=${redirectURI}`)
    return("login")
}

async function getToken() {
    if (fs.existsSync("./token.json")) {
        try { return fs.readFileSync("./token.json").toString() } 
        catch (error) { onError(error) }
    } else { return(login("initial")) }
}

async function getPlaylistID() {
    const url = reader.question("\nInput playlist URL: ")
    if (/https:\/\/open.spotify.com\/playlist\/.{22}/.exec(url)) {
        return url.split("playlist/").pop().split("?")[0].substring(0,22)
    } else { onError("Error: Provided playlist URL is invalid.") }
}

function getTracks(url, token, items) {
    return new Promise((resolve) => {
        request.get({headers: { "Authorization": `Bearer ${token}` }, url: url}, function(error, response, body) {
            if (!error && response.statusCode === 200) {
                const parsedBody = JSON.parse(body)
                items.push(...parsedBody.items)
                console.log(`   # of tracks received: ${items.length}`)
                if (parsedBody.next) { resolve(getTracks(parsedBody.next, token, items))} 
                else { resolve(items) }
            } else if (response.statusCode === 401) {
                resolve(login("expired"))
            } else { onError(error || response.statusCode) }
        })
    })
}

function distillTracks(tracks) {
    let distilledTracks = []
    let albumCount = []
    let artistCount = []

    for (track of tracks) {
        const distilledTrack = {
            "uri": track.track.uri,
            "name": track.track.name,
            "album": track.track.album.name,
            "artist": track.track.artists[0].name,
            "albumID": track.track.album.id,
            "artistID": track.track.artists[0].id
        }
        distilledTracks.push(distilledTrack)

        const albumCountIndex = albumCount.findIndex(obj => obj.albumID === track.track.album.id)
        if (albumCountIndex === -1) {
            albumCount.push({"albumID": track.track.album.id, "count": 1})
        } else  if (Number.isInteger(albumCountIndex)) {
            albumCount[albumCountIndex].count++
        }

        const artistCountIndex = artistCount.findIndex(obj => obj.artistID === track.track.artists[0].id)
        if (artistCountIndex === -1) {
            artistCount.push({"artistID": track.track.artists[0].id, "count": 1})
        } else  if (Number.isInteger(artistCountIndex)) {
            artistCount[artistCountIndex].count++
        }
    }

    for (track of distilledTracks) {
        track.albumCount = albumCount.find(obj => obj.albumID === track.albumID).count
        track.artistCount = artistCount.find(obj => obj.artistID === track.artistID).count
    }

    return distilledTracks
}

function sortTracks(tracks) {
    tracks.forEach((track) => {
        if (track.albumCount == 1 && track.artistCount != 1) {
            track.albumID = null
        } else if (track.artistCount == 1) { 
            track.albumID = null
            track.artistID = null 
        }
    })
    const sort1 = _.sortBy(tracks, "albumID").reverse()           // sort by album (reverse order)
    const sort2 = _.sortBy(sort1, "albumCount")                   // sort by album count
    const sort3 = _.sortBy(sort2, "artistID")                     // sort by artist
    const sortedTracks = _.sortBy(sort3, "artistCount").reverse() // sort by artist count (reverse order)
    const sortedTrackURIs = []
    for (track of sortedTracks) { sortedTrackURIs.push(track.uri) }
    return sortedTrackURIs
}

function getUserID(token) {
    const options = {
        url: "https://api.spotify.com/v1/me",
        headers: { "Authorization": `Bearer ${token}`},
        json: true
    }
    return new Promise((resolve) => {
        request.get(options, function(error, response, body) {
            if (!error && response.statusCode === 200) { resolve(body.id) } 
            else { onErr(error || body.error) }
        }) 
    })   
}

function getPlaylistDetails(playlistID, token) {
    const detailsOptions = {
        url: `https://api.spotify.com/v1/playlists/${playlistID}`,
        headers: { "Authorization": `Bearer ${token}` },
        json: true
    }
    return new Promise((resolve) => {
        request.get(detailsOptions, function(error, response, body) {
            if (!error && response.statusCode === 200) {
                resolve({
                    "name": body.name,
                    "description": body.description,
                    "coverImageURL": body.images[0].url
                })
            } else { onError(error || body.error) }
        })
    })
}

function getCoverImage(coverImageURL) {
    return new Promise((resolve) => {
        request.get(coverImageURL, {encoding: null}, function(error, response, body) {
            if (!error && response.statusCode === 200) { resolve(Buffer.from(body).toString("base64")) } 
            else { onErr(error || body.error || response.statusCode) }
        })
    })
}

function createPlaylist(details, userID, token) {
    const createOptions = {
        url: `https://api.spotify.com/v1/users/${userID}/playlists`,
        body: {
            "name": details.name + " (Sorted)",
            "public": false,
            "description": details.description
        },
        headers: { "Authorization": `Bearer ${token}` },
        json: true
    }
    return new Promise((resolve) => {
        request.post(createOptions, function(error, response, body) {
            if (!error && response.statusCode === 201) { resolve(body.id) } 
            else { onError(error || body.error || response.statusCode) }
        })
    })
}

async function uploadCoverImage(playlistID, coverImage, token) {
    const compressedImage = await resizeBase64Img(coverImage, 640, 640)
    const bodyImage = compressedImage.length/1000 > 256 ? await resizeBase64Img(coverImage, 300, 300) : compressedImage
    const uploadOptions = {
        url: `https://api.spotify.com/v1/playlists/${playlistID}/images`,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "image/jpeg",
            "content-length": bodyImage.length
        },
        body: bodyImage
    }
    return new Promise((resolve) => {
        request.put(uploadOptions, function(error, response, body) {
            if (!error && response.statusCode === 202) { resolve(true) } 
            else { onError(error || body.error || response.statusCode) }
        })
    })
}

async function resizeBase64Img(imageData, height, width) {
    try {
        let resizedImage = Buffer.from(imageData, "base64")
        resizedImage = await sharp(resizedImage).resize(height, width).toBuffer()
        return resizedImage.toString("base64")
    } catch (error) {
        onError(error)
    }
  }

function uploadTracks(tracks, playlistID, token) {
    const uploadOptions = {
        url: `https://api.spotify.com/v1/playlists/${playlistID}/tracks`,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: `{"uris": ${JSON.stringify(tracks)}}`
    }
    return new Promise((resolve) => {
        request.post(uploadOptions, function(error, response, body) {
            if (!error && response.statusCode === 201) { resolve(true) } 
            else { onError(error || body.error || response.statusCode) }
        })
    })
}

function onError(error) {
    console.log(error)
    process.exit(1)
}

// Function that runs on start
async function onStart() {
    try { 
        const token = await getToken()
        if (token === "login") { return }
        const playlistID = await getPlaylistID()
        
        console.log("Getting tracks:")
        const tracks = await getTracks(`https://api.spotify.com/v1/playlists/${playlistID}/tracks`, token, [])
        if (tracks === "login") { return }
        
        console.log("Distilling tracks:")
        const distilledTracks = distillTracks(tracks)
        
        console.log(`Sorting ${distilledTracks.length} tracks:`)
        const sortedTracks = sortTracks(distilledTracks)
        
        const userID = await getUserID(token)
        const playlistDetails = await getPlaylistDetails(playlistID, token)
        const coverImage = await getCoverImage(playlistDetails.coverImageURL)

        console.log("Creating playlist:")
        const newPlaylistID = await createPlaylist(playlistDetails, userID, token)
        
        console.log("Uploading cover image to playlist:")
        const didUploadImage = await uploadCoverImage(newPlaylistID, coverImage, token)

        console.log("Adding tracks to playlist:")
        if (sortedTracks.length > 100) { 
            for (let i = 0; i < sortedTracks.length; i = i + 100) {
                const trackGroup = sortedTracks.slice(0 + i, 100 + i) // Can only upload 100 tracks at a time
                didUploadTrackGroup = await uploadTracks(trackGroup, newPlaylistID, token)
            }
        } else { didUploadTracks = await uploadTracks(sortedTracks, newPlaylistID, token) }

        console.log("Complete!")
        process.exit(0)
    } 
    catch (error) { onError(error) }
}

onStart()
