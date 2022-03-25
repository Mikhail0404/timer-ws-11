require("dotenv").config();

const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const nunjucks = require("nunjucks");
const crypto = require("crypto");
const {nanoid} = require("nanoid");
const {MongoClient, ObjectID} = require("mongodb");
const {URL} = require("url");
const WebSocket = require("ws");

const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({clientTracking: false, noServer: true});

const clients = new Map();

const users = new Map();

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]"
  }
});

const clientPromise = MongoClient.connect(process.env.DB_URI, {
  useUnifiedTopology: true
});

const port = process.env.PORT || 3000;


app.set("view engine", "njk");

app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());


const dbConnect = async () => {
  try {
    const client = await clientPromise;
    return client.db("timer");
  } catch (e) {
    throw e;
  }
};

app.use(async (req, res, next) => {
  try {
    req.db = await dbConnect();
    next();
  } catch (e) {
    next(e);
  }
});


const hash = (d) => crypto.createHash("sha256").update(d).digest("hex");

const auth = () => async (req, res, next) => {
  
  if (!req.cookies["sessionId"]) {
    return next();
  }
  
  const user = await findUserBySessionId(req.db, req.cookies["sessionId"]);
  
  if (!user) {
    return next();
  }
  
  req.user = user;
  req.sessionId = req.cookies["sessionId"];
  
  
  next();
};

app.get("/", auth(), async (req, res) => {
  
  const token = nanoid();
  
  users.set(token, req.user);
  
  res.render("index", {
    user: req.user,
    token: token,
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
    signUpError: req.query.signUpError === "true" ? "User is already exist" : req.query.signUpError
  });
});

app.post("/login", bodyParser.urlencoded({extended: false}), async (req, res) => {
  if (!req.body) return res.sendStatus(400);
  const {username, password} = req.body;
  
  const user = await findUserByParam(req.db, {username});
  
  if (!user || user.password !== hash(password)) {
    return res.redirect("/?authError=true");
  }
  
  const session = await createSession(req.db, ObjectID(user._id));
  
  res.cookie("sessionId", session, {httpOnly: true});
  
  res.redirect("/");
});

app.post("/signup", bodyParser.urlencoded({extended: false}), async (req, res) => {
  if (!req.body) return res.sendStatus(400);
  const {username, password} = req.body;
  
  if (await findUserByParam(req.db, {username})) {
    return res.redirect("/?signUpError=true");
  }
  
  const user = await createUser(req.db, username, password);
  
  const session = await createSession(req.db, ObjectID(user.insertedId));
  
  res.cookie("sessionId", session, {httpOnly: true});
  
  res.redirect("/");
});

app.get("/logout", auth(), async (req, res) => {
  if (!req.user) {
    res.redirect("/");
  }
  await deleteSession(req.db, req.sessionId);
  res.clearCookie("sessionId").redirect("/");
});


server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});

server.on("upgrade", async (req, socket, head) => {
  const {searchParams} = new URL(req.url, `http://${req.headers.host}`);
  const token = searchParams && searchParams.get('token');
  const user = users.get(token);
  
  if (!user) {
    soket.write('HTTP/1.1 401\r\n\r\n');
    soket.destroy();
    return;
  }
  
  req.userId = user._id;
  
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const db = await dbConnect();
    wss.emit("connection", ws, req, db);
  });
});


wss.on("connection", async (ws, req, db) => {
  
  clients.set(req.userId, ws);
  
  ws.on("close", () => {
    clients.delete(req.userId);
  });
  
  ws.on("message", async (msg) => {
    let data;
    
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.log(e);
      return;
    }
    
    const timersList = await findTimersListByUserId(db, ObjectID(req.userId));
    
    let result = {};
    
    switch (data.type) {
      case 'all_timers':
        ws.send(JSON.stringify({
          type: 'active_timers',
          activeTimers: prepTimers(timersList.filter(el => el.isActive))
        }));
        ws.send(JSON.stringify({
          type: 'old_timers',
          oldTimers: prepTimers(timersList.filter(el => !el.isActive))
        }));
        break;
      case 'active_timers':
        ws.send(JSON.stringify({
          type: 'active_timers',
          activeTimers: prepTimers(timersList.filter(el => el.isActive))
        }));
        break;
      case 'add_timer':
        const description = data.description;
        const timer = await createTimer(db, {description, userId: ObjectID(req.userId)});
        ws.send(JSON.stringify({
          type: 'add_timer',
          id: timer.insertedId,
          description
        }));
        break;
      case 'stop_timer':
        await deactivatedTimer(db, ObjectID(data.id));
        ws.send(JSON.stringify({
          type: 'stop_timer',
          id: data.id
        }));
        break;
      default:
        break;
    }
    
    
  })
});


const prepTimers = (timerList) => {
  timerList.forEach(el => {
    if (el.isActive) {
      el["progress"] = Date.now() - el.start;
    } else {
      el["duration"] = el.end - el.start;
    }
  });
  
  return timerList;
};


// ----- CRUD -----

//
// Create
//

const createUser = async (db, username, password) => db.collection("users").insertOne({
  username,
  password: hash(password)
});

const createSession = async (db, userId) => {
  
  const sessionId = nanoid();
  
  await db.collection("sessions").insertOne({
    userId,
    sessionId
  });
  
  return sessionId;
};

const createTimer = async (db, prop) => db.collection("timers").insertOne({
  ...prop,
  start: new Date(),
  isActive: true
});

//
// Read
//

const findUserByParam = async (db, param) => db.collection("users").findOne(param);


const findSessionById = async (db, sessionId) => db.collection("sessions").findOne({sessionId});

const findTimersListByUserId = async (db, userId) => db.collection("timers").find({userId}).toArray();

const findUserBySessionId = async (db, sessionId) => {
  const session = await findSessionById(db, sessionId);
  
  if (!session) {
    return;
  }
  
  return findUserByParam(db, {_id: ObjectID(session.userId)});
};

//
// Update
//

const deactivatedTimer = async (db, _id) => db.collection("timers")
  .updateOne({_id}, {$set: {end: new Date(), isActive: false}}, {returnOriginal: false});

//
// Delete
//

const deleteSession = async (db, sessionId) => {
  await db.collection("sessions").deleteOne({sessionId});
};


// ----------
