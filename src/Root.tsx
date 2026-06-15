import React, { useState, useEffect } from 'react';
import App from './App';
import Auth from './Auth';
import Activation from './Activation';
import { User, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Loader2 } from 'lucide-react';

export default function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isActivated, setIsActivated] = useState<boolean | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      
      if (currentUser) {
        const isOwner = currentUser.email === 'skywings38@gmail.com';
        if (isOwner) {
          setIsActivated(true);
        }
        
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userDoc = await getDoc(userRef);
          
          if (userDoc.exists()) {
            if (!isOwner) {
              setIsActivated(userDoc.data().isActivated);
            } else if (!userDoc.data().isActivated) {
              // Update owner to be activated in DB if needed
              await setDoc(userRef, { isActivated: true }, { merge: true });
            }
          } else {
            // Initialize new user
            await setDoc(userRef, {
              email: currentUser.email,
              isActivated: isOwner,
              createdAt: serverTimestamp()
            });
            if (!isOwner) {
              setIsActivated(false);
            }
          }
        } catch (error) {
          console.error("Error loading user profile:", error);
          if (!isOwner) {
            setIsActivated(false);
          }
        }
      } else {
        setIsActivated(null);
      }
      
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#1e1e1e]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!user) {
    return <Auth onAuthenticated={setUser} />;
  }

  if (isActivated === true) {
    return <App user={user} />;
  }

  return <Activation user={user} onActivated={() => setIsActivated(true)} />;
}
