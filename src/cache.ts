import NodeCache from 'node-cache';
// this is not a design usage I'd normally apply, especially for the chat messages and user registrations
// I'd porbably use an application-appropriate database and depending on the traffic profile
// and probably have the webserver pushing updates to a queue and a queue consumer populating the database
// I would probably keep the sessions in a shared store like redis but it's a pretty crunched timeline
// to complete this assignment around a full-time job and family obligations,
// the data source can be swapped out or migrated, and scallability is not MVP...
export const mySessionCache = new NodeCache({ stdTTL: 60 * 60 * 4 }); // default 4-hr session expirey
export const myUserCache = new NodeCache();
