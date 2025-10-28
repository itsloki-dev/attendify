const express = require('express');
const connectDB = require('./mongodb');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const Papa = require('papaparse');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

connectDB();

require('dotenv').config();

app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

app.set('view engine','ejs');
//-------------------------------MY MIDDLEWARES-------------------------------
const verifyAuth = require('./middlewares/verifyAuth');
const verifyAdminAuth = require('./middlewares/verifyAdminAuth');
const isAttendanceLocked = require('./middlewares/isAttendanceLocked');
//-----------------------------------UTILITY-----------------------------------
const { hashPassword, verifyPassword } = require('./utility/hashUtil');
//-----------------------------------ROUTES-----------------------------------
app.get('/',(req,res)=>{
    res.render('index');
});
app.get('/add-participants/:id',verifyAuth, isAttendanceLocked,(req,res)=>{
    res.render('manage');
});
app.get('/attendance/:id',verifyAuth,(req,res)=>{
    res.render('attendance');
});



//--------------------------------API ENDPOINTS--------------------------------
const Event = require('./models/Event');
//DELETE Request
app.delete('/delete-event', async (req,res)=>{
    const token = req.cookies.authCookie;
    try{
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const id = payload.eventId;
        
        const event = await Event.findOne({ id });
        const title = event.title;

        await Event.deleteOne({ id });
        res.json({ success:true,message:`Successfully Deleted Event "${title} (${id})"`} );
    }catch(err){
        console.log(err.message);
        res.json({ success:false,message:`Error Deleting Event: ${err.message}` });
    }
});
//GET Requests
app.get('/events-data',async (req,res)=>{
    try{
        const events = await Event.find();
        const formattedEvents = events.map(event =>({
            id: event.id,
            title: event.title,
            createdAt: event.createdAt.toLocaleDateString('en-GB'),
            participants: event.participants.length,
            attendanceLocked: event.attendanceLocked
        }));

        res.json({ events: formattedEvents });
    }catch(err){
        console.log('Error fetching events: ',err.message);
        res.json({ message: `SERVER ERROR: Fetching events -> ${err.message}`});
    }
})
app.get('/participants-data',verifyAuth,async (req,res)=>{
    const token = req.cookies.authCookie;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const id = payload.eventId;
    try{
        const event = await Event.findOne({ id });
        const participantArray = event.participants;
        res.json({ success:true,message:"Successfully fetched participants data",participantArray });
    }catch(err){
        res.json({ success:false,message:"Failed to fetch participants info" })
    }
})
app.get('/export-csv',verifyAdminAuth, async (req,res)=>{
    const { eventId } = req.user;
    try{
        const event = await Event.findOne({ id:eventId });

        const csvData = event.participants.map( (p, index) => ({
            sno: index+1,
            name: p.name,
            regno: p.regno,
            phno: p.phno,
            attendance: p.present?"Present":"Absent",
            timestamp: p.timestamp
        }));

        const csv = Papa.unparse(csvData,{
            columns: ['sno','name','regno','phno','attendance','timestamp']
        });

        res.json({
            success:true,
            message:"CSV Generated Successfully",
            file:csv
        });
    }catch(err){
        console.log("Error generating CSV file: ",err.message);
        res.json({ success:false,message:"Error Generating CSV file" });
    }
});
//POST Requests
app.post('/new-event', async (req,res)=>{
    const { eventTitle, adminPass, ocPass, contact } = req.body;
    try{
        //hashing passwords
        const hashedAdminPass = await hashPassword(adminPass);
        const hashedOcPass = await hashPassword(ocPass);
        //unique id generator
        let id, exists;
        do{
            id='';
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            for(let i=0;i<4;i++){
                const randomIndex = Math.floor(Math.random()*chars.length);
                id += chars[randomIndex];
            }
            exists = await Event.findOne({ id });
        }while(exists);
        const newEvent = new Event({
            id,
            title: eventTitle,
            users:{ adminPass:hashedAdminPass,ocPass:hashedOcPass },
            contact
        });
        await newEvent.save();
        console.log(`New Event "${eventTitle}" created`);

        res.json({ success:true, id });
    }catch(err){
        console.log(`Error creating event: `,err.message);
        res.json({ success:false, message:`SERVER ERROR: Event Creation -> ${err.message}` });
    }
})
app.post('/adminAuth', async (req,res) =>{
    const { adminPass,eventId } = req.body;
    try{
        const event = await Event.findOne({ id:eventId });
        if( await verifyPassword(adminPass,event.users.adminPass)){
        // if(event.users.adminPass == adminPass){
            const payload = {
                role: "admin",
                eventId: event.id
            };
            const token = jwt.sign(payload, process.env.JWT_SECRET,{ expiresIn:"2h" });

            res.clearCookie('authCookie');//if login into a new event, log out of prev event
            res.cookie('authCookie', token,{
                httpOnly: true,
                secure: false, //change to true on production
                sameSite: 'Strict',
                maxAge: 2*60*60*1000 // match jwt token expiration time
            })

            res.json({ 
                success:true,
                message: "Admin Authentication Successful",
                message2:`Logged in as ${payload.role.toUpperCase()} for Event ${event.title}!`
            })
        }else{
            res.json({ success:false,message: "Wrong Password: Admin Authentication Failed"})
        }
    }catch(err){
        console.log('Error authenticating admin user: ',err.message);
        res.json({ success:false, message: `SERVER ERROR: Authenticating admin -> ${err.message }`})
    }

})
app.post('/auth', async (req,res) =>{
    const { password,eventId } = req.body;
    try{
        const event = await Event.findOne({ id:eventId });
        const isAdmin = await verifyPassword(password,event.users.adminPass);
        const isOc = await verifyPassword(password,event.users.ocPass);
        if(isAdmin || isOc){
            const payload = {
                role: (isAdmin)?"admin":"oc",
                eventId: event.id
            };
            const token = jwt.sign(payload, process.env.JWT_SECRET,{ expiresIn:"2h" });

            res.clearCookie('authCookie');//if login into a new event, log out of prev event
            res.cookie('authCookie', token,{
                httpOnly: true,
                secure: false, //change to true on production
                sameSite: 'Strict',
                maxAge: 2*60*60*1000 // match jwt token expiration time
            })

            res.json({ 
                success:true,
                message: "Authentication Successful",
                message2:`Logged in as ${payload.role.toUpperCase()} for Event ${event.title}!`
            })
        }else{
            res.json({ success:false,message: "Wrong Password: Authentication Failed"})
        }
    }catch(err){
        console.log('Error authenticating user: ',err.message);
        res.json({ success:false, message: `SERVER ERROR: Authenticating user -> ${err.message }`})
    }

})
app.post('/verify-auth',(req,res)=>{
    const { eventId } = req.body;
    const token = req.cookies.authCookie;

    if(!token){
        return res.json({ isAdmin:false, isAuth:false });
    }

    try{
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const isAuth = payload.eventId === eventId;
        const isAdmin = isAuth && payload.role === "admin";

        res.json({ isAuth, isAdmin })
    }catch(err){
        res.json({ isAuth:false, isAdmin:false, message:"Auth Verification Failed" });
    }
})
app.post('/edit-event/:id', verifyAdminAuth, async (req, res)=>{
    const { eventTitle, adminPass, ocPass } = req.body;
    const token = req.cookies.authCookie;
    try{
        const payload = jwt.verify(token,process.env.JWT_SECRET);
        const event = await Event.findOne({ id:payload.eventId });

        let messages = [];
        if(eventTitle){
            messages.push(`Event "${event.title}" is now renamed as "${eventTitle}"`);
            event.title = eventTitle;
        }
        if(adminPass){
            event.users.adminPass = await hashPassword(adminPass);
            messages.push('Admin Password Updated');
        }
        if(ocPass){
            event.users.ocPass = await hashPassword(ocPass);
            messages.push('OC Password Updated');
        }

        await event.save();

        res.json({ success:true,messages })
    }catch(err){
        res.json({ success:false,message:"SERVER ERROR: Error updating DB"});
    }
})
app.post('/add-participants',verifyAuth, isAttendanceLocked,async (req,res)=>{
    const { participantArray } = req.body;
    const token = req.cookies.authCookie;

    try{
        const payload = jwt.verify(token,process.env.JWT_SECRET);
        const event = await Event.findOne({ id: payload.eventId });

        //remove duplicate entries
        const existingRegnos = new Set(event.participants.map(p => p.regno));
        existingRegnos.add("");//to omit null name, regno, timestamp entries
        const newParticipants = participantArray.filter(p => !existingRegnos.has(p.regno));

        function normalizeDate(ts) {
            if (!ts) return null;
            if (ts instanceof Date) return ts;
            const [datePart, timePart] = ts.split(' ');
            const [day, month, year] = datePart.split(/[-/]/);
            return new Date(`${year}-${month}-${day}T${timePart}:00`);
        }
          
        const validParticipants = newParticipants
          .filter(p => p.name && p.regno && p.timestamp)
          .map(p => ({
            ...p,
            timestamp: normalizeDate(p.timestamp)
        }));
          

        event.participants = event.participants.concat(validParticipants);
        await event.save();

        const newEntries = newParticipants.length;
        const duplicateEntries = participantArray.length - newEntries;

        const message = (duplicateEntries)?`${newEntries} new entries added.(${duplicateEntries} duplicate entries.)`:`${newEntries} new entries added`;
        res.json({ success:true,message })
    }catch(err){
        console.log(err);
        res.json({ success:false,message:"SERVER ERROR: New entries not saved to DB"});
    }
})
app.post('/attendance-trigger',verifyAuth, isAttendanceLocked,async (req,res)=>{
    const token = req.cookies.authCookie;
    try{
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const event = await Event.findOne({ id:payload.eventId });

        const { regno,attendance } = req.body;
        
        const participant = event.participants.find(p => p.regno === regno);
        if(!participant){
            return res.json({ success:false,message:"Participant Not Found"});
        }
        participant.present = attendance;
        await event.save();

        io.emit('attendanceUpdated',{ 
            regno:participant.regno, 
            attendance:participant.present 
        });

        res.json({ 
            success:true,
            message:`${participant.name}(${participant.regno}) marked as ${(attendance)?"present":"absent"}`
        });
    }catch(err){
        res.json({ success:false,message:"Error updating attendance" })
    }
});
app.post('/attendance-lock-toggle',verifyAdminAuth, async (req,res)=>{
    const user = req.user;
    try{
        const event = await Event.findOne({ id:user.eventId });
        const currLocked = !event.attendanceLocked;
        const currStatus = (currLocked)?"locked":"unlocked";
        event.attendanceLocked = currLocked;
        await event.save();

        res.json({ success:true,message:`Attendance ${currStatus} for event "${event.title}"`} );
    }catch(err){
        console.log("Error, attendance not locked/unlocked: ",err.message);
        res.json({ success:false,message:"Error: Attendance status not changesd" });
    }
});

app.post('/isAttendanceLocked',async (req,res)=>{
    const { eventId } = req.body;
    try{
        const event = await Event.findOne({ id:eventId });
        res.json({ success:true,isLocked:event.attendanceLocked })
    }catch(err){
        console.log('Error checking attendance status',err.message);
        res.json({ success:false,message:'Error checking attendance status'})
    } 
})

io.on('connection',(socket)=>{
    console.log('A user is connected');

    socket.on('disconnect',()=>{
        console.log('User disconnected');
    });
});

const port = 3000
server.listen(port, ()=>{
    console.log("Server is running at port: ",port);
});